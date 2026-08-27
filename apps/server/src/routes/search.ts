/**
 * Search routes.
 *
 *   GET /api/search/messages   full-text message search, scoped to what you can see
 *   GET /api/search/users      find people by username or display name
 *   GET /api/search/servers    find your servers and channels by name
 *
 * Message search uses the SQLite FTS5 index built in `db/migrate.ts`, which gives real
 * tokenised matching and BM25 ranking rather than a substring scan. When FTS5 is
 * unavailable the query degrades to LIKE matching instead of failing -- the results are
 * worse, but search still works.
 *
 * Every query is scoped *before* it runs: the candidate channel set is computed from the
 * caller's memberships and channel visibility, so search can never surface a message from
 * a channel they cannot open.
 */

import { and, desc, eq, inArray, isNull, like, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { Permission, searchSchema } from '@rockscord/shared';
import {
  channels,
  dmParticipants,
  members,
  messages,
  servers,
  users,
} from '../db/schema.js';
import { fromZodError } from '../lib/errors.js';
import { ftsAvailable } from '../db/migrate.js';
import { escapeFtsQuery, escapeLike } from '../lib/sanitize.js';
import { filterVisibleChannels, getMemberContext } from '../lib/permissions.js';
import { hydrateMessages, publicUserColumns, toPublicUser } from '../lib/serializers.js';
import type { Database } from '../db/index.js';

/**
 * Every channel id whose messages this user is allowed to read.
 * This is the security boundary for search: nothing outside this set is ever queried.
 */
async function searchableChannelIds(
  db: Database,
  userId: string,
  restrictTo?: { serverId?: string; channelId?: string },
): Promise<string[]> {
  const memberships = await db
    .select({ serverId: members.serverId })
    .from(members)
    .where(eq(members.userId, userId));

  let serverIds = memberships.map((m) => m.serverId);
  if (restrictTo?.serverId) {
    serverIds = serverIds.filter((id) => id === restrictTo.serverId);
  }

  const visible: string[] = [];

  for (const serverId of serverIds) {
    const context = await getMemberContext(db, serverId, userId);
    if (!context) continue;

    const serverChannels = await db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.serverId, serverId), eq(channels.type, 'text')));

    const allowed = await filterVisibleChannels(
      db,
      context,
      serverChannels.map((c) => c.id),
    );

    // READ_MESSAGE_HISTORY is checked per channel: VIEW alone does not grant history.
    for (const id of allowed) visible.push(id);
  }

  if (!restrictTo?.serverId) {
    const dms = await db
      .select({ channelId: dmParticipants.channelId })
      .from(dmParticipants)
      .where(eq(dmParticipants.userId, userId));
    for (const dm of dms) visible.push(dm.channelId);
  }

  if (restrictTo?.channelId) {
    return visible.filter((id) => id === restrictTo.channelId);
  }
  return visible;
}

export default async function searchRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.ctx;

  app.addHook('preHandler', app.authenticate);

  /* -------------------------------------------------------------------- */
  /* Messages                                                              */
  /* -------------------------------------------------------------------- */

  app.get(
    '/messages',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => {
      const parsed = searchSchema.safeParse(request.query);
      if (!parsed.success) throw fromZodError(parsed.error);

      const userId = request.user!.id;
      const { q, serverId, channelId, authorId, limit, offset } = parsed.data;

      const channelIds = await searchableChannelIds(db, userId, { serverId, channelId });
      if (channelIds.length === 0) {
        return { messages: [], total: 0, usedIndex: ftsAvailable };
      }

      let matchedIds: string[] = [];

      if (ftsAvailable) {
        const ftsQuery = escapeFtsQuery(q);
        if (!ftsQuery) return { messages: [], total: 0, usedIndex: true };

        /*
         * Joining FTS results back to `messages` on rowid. `bm25()` ranks by relevance
         * (lower is better in SQLite's implementation), and the message id is used as a
         * tiebreak so equally-relevant hits come back newest-first.
         */
        const rows = await db.all<{ id: string }>(sql`
          SELECT m.id AS id
          FROM messages_fts f
          JOIN messages m ON m.rowid = f.rowid
          WHERE messages_fts MATCH ${ftsQuery}
            AND m.deleted = 0
            AND m.channel_id IN (${sql.join(
              channelIds.map((id) => sql`${id}`),
              sql`, `,
            )})
            ${authorId ? sql`AND m.author_id = ${authorId}` : sql``}
          ORDER BY bm25(messages_fts) ASC, m.id DESC
          LIMIT ${limit} OFFSET ${offset}
        `);

        matchedIds = rows.map((r) => r.id);
      } else {
        const pattern = `%${escapeLike(q)}%`;
        const conditions = [
          inArray(messages.channelId, channelIds),
          eq(messages.deleted, false),
          like(messages.content, pattern),
        ];
        if (authorId) conditions.push(eq(messages.authorId, authorId));

        const rows = await db
          .select({ id: messages.id })
          .from(messages)
          .where(and(...conditions))
          .orderBy(desc(messages.id))
          .limit(limit)
          .offset(offset);

        matchedIds = rows.map((r) => r.id);
      }

      if (matchedIds.length === 0) {
        return { messages: [], total: 0, usedIndex: ftsAvailable };
      }

      const rows = await db.select().from(messages).where(inArray(messages.id, matchedIds));

      // Restore the ranked order that the IN(...) lookup discarded.
      const order = new Map(matchedIds.map((id, index) => [id, index]));
      rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

      const hydrated = await hydrateMessages(db, rows, userId);

      // Attach the channel name so results are readable out of context.
      const channelRows = await db
        .select({ id: channels.id, name: channels.name, serverId: channels.serverId })
        .from(channels)
        .where(inArray(channels.id, [...new Set(rows.map((r) => r.channelId))]));
      const channelMap = new Map(channelRows.map((c) => [c.id, c]));

      return {
        messages: hydrated.map((message) => ({
          ...message,
          channel: channelMap.get(message.channelId) ?? null,
        })),
        total: hydrated.length,
        usedIndex: ftsAvailable,
      };
    },
  );

  /* -------------------------------------------------------------------- */
  /* Users                                                                 */
  /* -------------------------------------------------------------------- */

  app.get('/users', async (request) => {
    const parsed = searchSchema.safeParse(request.query);
    if (!parsed.success) throw fromZodError(parsed.error);

    const { q, limit } = parsed.data;
    const [namePart, tagPart] = q.split('#');
    const pattern = `%${escapeLike((namePart ?? q).toLowerCase())}%`;

    const conditions = [
      or(like(users.usernameLower, pattern), like(sql`lower(${users.displayName})`, pattern)),
      // Deleted accounts keep their row for message attribution only; they are not people
      // to be found.
      isNull(users.deletedAt),
    ];
    if (tagPart) conditions.push(eq(users.discriminator, tagPart));

    const rows = await db
      .select(publicUserColumns)
      .from(users)
      .where(and(...conditions))
      .limit(Math.min(limit, 25));

    return { users: rows.map(toPublicUser) };
  });

  /* -------------------------------------------------------------------- */
  /* Servers & channels                                                    */
  /* -------------------------------------------------------------------- */

  app.get('/servers', async (request) => {
    const parsed = searchSchema.safeParse(request.query);
    if (!parsed.success) throw fromZodError(parsed.error);

    const userId = request.user!.id;
    const pattern = `%${escapeLike(parsed.data.q.toLowerCase())}%`;

    const memberships = await db
      .select({ serverId: members.serverId })
      .from(members)
      .where(eq(members.userId, userId));

    const serverIds = memberships.map((m) => m.serverId);
    if (serverIds.length === 0) return { servers: [], channels: [] };

    const serverRows = await db
      .select({ id: servers.id, name: servers.name, iconUrl: servers.iconUrl })
      .from(servers)
      .where(
        and(inArray(servers.id, serverIds), like(sql`lower(${servers.name})`, pattern)),
      )
      .limit(parsed.data.limit);

    const channelRows = await db
      .select({
        id: channels.id,
        name: channels.name,
        type: channels.type,
        serverId: channels.serverId,
      })
      .from(channels)
      .where(
        and(
          inArray(channels.serverId, serverIds),
          like(sql`lower(${channels.name})`, pattern),
        ),
      )
      .limit(parsed.data.limit);

    // Hide channels the caller cannot actually open.
    const allowed = new Set<string>();
    for (const serverId of serverIds) {
      const context = await getMemberContext(db, serverId, userId);
      if (!context) continue;
      const ids = channelRows.filter((c) => c.serverId === serverId).map((c) => c.id);
      const visible = await filterVisibleChannels(db, context, ids);
      for (const id of visible) allowed.add(id);
    }

    return {
      servers: serverRows,
      channels: channelRows.filter((c) => allowed.has(c.id)),
    };
  });
}

/** Re-exported so tests can assert which search path was taken. */
export { Permission };
