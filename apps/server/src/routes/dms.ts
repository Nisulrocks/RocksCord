/**
 * Direct message routes.
 *
 *   GET    /api/dms              open conversations, most recent first
 *   POST   /api/dms              open (or reopen) a conversation with a user
 *   DELETE /api/dms/:channelId   hide a conversation from the sidebar
 *
 * A DM is a `channels` row with `serverId = NULL` plus rows in `dm_participants`, so
 * messages, attachments, read state, search, and even voice all work in DMs without a
 * single special case in those subsystems.
 *
 * Closing a DM only sets `closed` for the person who closed it. History is never
 * destroyed, and a new message reopens the conversation for both sides.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { channels, dmParticipants, friendships, users } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { loadDMChannels, publicUserColumns, toPublicUser } from '../lib/serializers.js';
import { emitToUser, moveUserSockets } from '../lib/emit.js';
import { Rooms } from '@rockscord/shared';
import type { Database } from '../db/index.js';

/**
 * Find the existing 1:1 conversation between two users, if there is one.
 *
 * The query asks for channels that both users participate in and that have exactly two
 * participants -- the "exactly two" clause is what stops a future group DM from being
 * mistaken for the pair's private conversation.
 */
async function findDirectChannel(
  db: Database,
  a: string,
  b: string,
): Promise<string | null> {
  const rows = await db
    .select({ channelId: dmParticipants.channelId })
    .from(dmParticipants)
    .where(inArray(dmParticipants.userId, [a, b]))
    .groupBy(dmParticipants.channelId)
    .having(sql`count(distinct ${dmParticipants.userId}) = 2`);

  for (const row of rows) {
    const [totalRow] = await db
      .select({ total: sql<number>`count(*)` })
      .from(dmParticipants)
      .where(eq(dmParticipants.channelId, row.channelId));
    const total = Number(totalRow?.total ?? 0);
    if (total === 2) return row.channelId;
  }
  return null;
}

export default async function dmRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const { db } = ctx;

  app.addHook('preHandler', app.authenticate);

  app.get('/', async (request) => {
    return { channels: await loadDMChannels(db, request.user!.id) };
  });

  app.post(
    '/',
    { config: { rateLimit: { max: 30, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const { userId: targetId } = (request.body ?? {}) as { userId?: string };
      const userId = request.user!.id;

      if (!targetId) throw ApiError.badRequest('userId is required');
      if (targetId === userId) throw ApiError.badRequest('You cannot DM yourself');

      const [target] = await db
        .select(publicUserColumns)
        .from(users)
        .where(eq(users.id, targetId))
        .limit(1);
      if (!target) throw ApiError.notFound('No such user');

      // A block in either direction prevents the conversation from being opened.
      const { low, high } = userId < targetId
        ? { low: userId, high: targetId }
        : { low: targetId, high: userId };

      const [relationship] = await db
        .select({ status: friendships.status })
        .from(friendships)
        .where(and(eq(friendships.userLowId, low), eq(friendships.userHighId, high)))
        .limit(1);

      if (relationship?.status === 'blocked') {
        throw ApiError.forbidden('You cannot message that person');
      }

      const existingId = await findDirectChannel(db, userId, targetId);

      if (existingId) {
        // Reopen it for whoever had hidden it.
        await db
          .update(dmParticipants)
          .set({ closed: false })
          .where(
            and(eq(dmParticipants.channelId, existingId), eq(dmParticipants.userId, userId)),
          );

        const [row] = await db
          .select()
          .from(channels)
          .where(eq(channels.id, existingId))
          .limit(1);

        await moveUserSockets(ctx, userId, Rooms.channel(existingId), 'join');

        return reply.send({
          channel: {
            id: existingId,
            type: 'dm' as const,
            recipients: [toPublicUser(target)],
            lastMessageAt: row?.lastMessageAt ?? null,
            createdAt: row?.createdAt ?? Date.now(),
          },
          created: false,
        });
      }

      const channelId = newId();
      const createdAt = Date.now();

      await db.transaction(async (tx) => {
        await tx.insert(channels).values({
          id: channelId,
          serverId: null,
          name: 'Direct Message',
          type: 'dm',
          createdAt,
        });
        await tx.insert(dmParticipants).values([
          { channelId, userId },
          { channelId, userId: targetId },
        ]);
      });

      const [me] = await db
        .select(publicUserColumns)
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      const forMe = {
        id: channelId,
        type: 'dm' as const,
        recipients: [toPublicUser(target)],
        lastMessageAt: null,
        createdAt,
      };
      const forThem = {
        id: channelId,
        type: 'dm' as const,
        recipients: [toPublicUser(me!)],
        lastMessageAt: null,
        createdAt,
      };

      await moveUserSockets(ctx, userId, Rooms.channel(channelId), 'join');
      emitToUser(ctx, targetId, 'dm:create', forThem);

      return reply.status(201).send({ channel: forMe, created: true });
    },
  );

  app.delete('/:channelId', async (request) => {
    const { channelId } = request.params as { channelId: string };
    const userId = request.user!.id;

    const [participant] = await db
      .select({ userId: dmParticipants.userId })
      .from(dmParticipants)
      .where(and(eq(dmParticipants.channelId, channelId), eq(dmParticipants.userId, userId)))
      .limit(1);

    if (!participant) throw ApiError.notFound('Conversation not found');

    await db
      .update(dmParticipants)
      .set({ closed: true })
      .where(and(eq(dmParticipants.channelId, channelId), eq(dmParticipants.userId, userId)));

    await moveUserSockets(ctx, userId, Rooms.channel(channelId), 'leave');
    return { ok: true };
  });
}
