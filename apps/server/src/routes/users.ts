/**
 * User routes.
 *
 *   GET    /api/users/:userId          public profile
 *   PATCH  /api/users/@me              update own profile
 *   DELETE /api/users/@me              delete (tombstone) own account
 *   GET   /api/users/@me/read-states  unread + mention state for every channel
 *   PATCH /api/users/@me/channels/:channelId/mute  mute or unmute a channel
 *
 * There is deliberately no "list all users" endpoint. Discovery happens through servers
 * you share, friends, and explicit username search -- not by enumerating the database.
 */

import { randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { LIMITS, deleteAccountSchema, updateProfileSchema } from '@rockscord/shared';
import {
  channels,
  dmParticipants,
  emailVerifications,
  friendships,
  memberRoles,
  members,
  messages,
  notifications,
  readStates,
  servers,
  sessions,
  users,
} from '../db/schema.js';
import {
  REFRESH_COOKIE_NAME,
  clearedRefreshCookieOptions,
  verifyPassword,
} from '../lib/auth.js';
import { ApiError, fromZodError } from '../lib/errors.js';
import { filterVisibleChannels, requireMember } from '../lib/permissions.js';
import { publicUserColumns, toPublicUser, toSelfUser } from '../lib/serializers.js';
import { sanitizeDisplayName } from '../lib/sanitize.js';
import { cleanText } from '../lib/sanitize.js';
import { emitToUsers } from '../lib/emit.js';
import * as presence from '../realtime/presence.js';

export default async function userRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const { db } = ctx;

  app.addHook('preHandler', app.authenticate);

  /* -------------------------------------------------------------------- */
  /* Own profile                                                           */
  /* -------------------------------------------------------------------- */

  app.patch('/@me', async (request) => {
    const parsed = updateProfileSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw fromZodError(parsed.error);

    const userId = request.user!.id;
    const patch: Record<string, unknown> = { updatedAt: Date.now() };

    if (parsed.data.displayName !== undefined) {
      const displayName = sanitizeDisplayName(parsed.data.displayName);
      if (!displayName) throw ApiError.badRequest('Display name cannot be empty');
      patch.displayName = displayName;
    }
    if (parsed.data.bio !== undefined) {
      patch.bio = parsed.data.bio ? cleanText(parsed.data.bio).slice(0, LIMITS.BIO_MAX) : null;
    }
    if (parsed.data.customStatus !== undefined) {
      patch.customStatus = parsed.data.customStatus
        ? cleanText(parsed.data.customStatus).slice(0, LIMITS.CUSTOM_STATUS_MAX)
        : null;
    }
    if (parsed.data.status !== undefined) patch.status = parsed.data.status;
    if (parsed.data.avatarUrl !== undefined) patch.avatarUrl = parsed.data.avatarUrl;

    await db.update(users).set(patch).where(eq(users.id, userId));

    // Presence lives in memory, so a status change has to be mirrored there or the
    // in-memory value would immediately overwrite what was just saved.
    if (parsed.data.status !== undefined || parsed.data.customStatus !== undefined) {
      presence.setStatus(
        userId,
        parsed.data.status ?? presence.getStatus(userId),
        parsed.data.customStatus,
      );
    }

    const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const self = toSelfUser(row!);

    // Everyone who shares a server or a DM with this user needs the updated profile.
    const audience = await visibleTo(userId);
    emitToUsers(ctx, audience, 'presence:update', {
      userId,
      status: self.status,
      customStatus: self.customStatus,
    });

    return { user: self };
  });

  /**
   * Everyone who can see this user: co-members of shared servers, plus DM partners.
   * Used to scope presence and profile broadcasts so they do not fan out to strangers.
   */
  async function visibleTo(userId: string): Promise<string[]> {
    const serverIds = (
      await db
        .select({ serverId: members.serverId })
        .from(members)
        .where(eq(members.userId, userId))
    ).map((r) => r.serverId);

    const coMembers = serverIds.length
      ? await db
          .select({ userId: members.userId })
          .from(members)
          .where(inArray(members.serverId, serverIds))
      : [];

    const dmChannelIds = (
      await db
        .select({ channelId: dmParticipants.channelId })
        .from(dmParticipants)
        .where(eq(dmParticipants.userId, userId))
    ).map((r) => r.channelId);

    const dmPartners = dmChannelIds.length
      ? await db
          .select({ userId: dmParticipants.userId })
          .from(dmParticipants)
          .where(inArray(dmParticipants.channelId, dmChannelIds))
      : [];

    const set = new Set<string>([
      ...coMembers.map((r) => r.userId),
      ...dmPartners.map((r) => r.userId),
    ]);
    set.delete(userId);
    return [...set];
  }

  /* -------------------------------------------------------------------- */
  /* Public profile                                                        */
  /* -------------------------------------------------------------------- */

  app.get('/:userId', async (request) => {
    const { userId } = request.params as { userId: string };

    const [row] = await db
      .select(publicUserColumns)
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!row) throw ApiError.notFound('No such user');

    // Which servers do we have in common? The profile popup shows this.
    const mine = (
      await db
        .select({ serverId: members.serverId })
        .from(members)
        .where(eq(members.userId, request.user!.id))
    ).map((r) => r.serverId);

    const shared = mine.length
      ? await db
          .select({ serverId: members.serverId })
          .from(members)
          .where(and(eq(members.userId, userId), inArray(members.serverId, mine)))
      : [];

    return {
      user: toPublicUser(row),
      mutualServerIds: shared.map((r) => r.serverId),
    };
  });

  /* -------------------------------------------------------------------- */
  /* Read state                                                            */
  /* -------------------------------------------------------------------- */

  app.get('/@me/read-states', async (request) => {
    const userId = request.user!.id;

    const rows = await db
      .select()
      .from(readStates)
      .where(eq(readStates.userId, userId));

    /*
     * "Unread" is derived, not stored: compare the channel's newest message id with the
     * last one this user acknowledged. Ids sort chronologically, so this is a string
     * comparison rather than a timestamp join.
     */
    const channelIds = await accessibleChannelIds(userId);
    const latest = channelIds.length
      ? await db
          .select({
            channelId: messages.channelId,
            lastId: sql<string>`max(${messages.id})`,
          })
          .from(messages)
          .where(
            and(inArray(messages.channelId, channelIds), eq(messages.deleted, false)),
          )
          .groupBy(messages.channelId)
      : [];

    const latestMap = new Map(latest.map((r) => [r.channelId, r.lastId]));
    const stateMap = new Map(rows.map((r) => [r.channelId, r]));

    const result = channelIds.map((channelId) => {
      const state = stateMap.get(channelId);
      const newest = latestMap.get(channelId) ?? null;
      const lastRead = state?.lastReadMessageId ?? null;
      return {
        channelId,
        lastReadMessageId: lastRead,
        mentionCount: state?.mentionCount ?? 0,
        muted: state?.muted ?? false,
        unread: Boolean(newest) && (!lastRead || newest! > lastRead),
      };
    });

    return { readStates: result };
  });

  /**
   * Mark every channel in a server as read.
   *
   * Done here rather than by the client acknowledging each channel in turn, because the
   * client does not know the newest message id for channels it has never opened -- which
   * is precisely the set someone reaches for this to clear.
   */
  app.post('/@me/read-states/server/:serverId', async (request) => {
    const { serverId } = request.params as { serverId: string };
    const userId = request.user!.id;

    // `requireMember` already 404s a non-member, so this is the same lookup narrowed:
    // it returns the context rather than just proving membership.
    const context = await requireMember(db, serverId, userId);
    const serverChannels = await db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.serverId, serverId));

    // Only channels they can actually see: marking a hidden one read would itself be a
    // way to learn it exists.
    const visible = await filterVisibleChannels(
      db,
      context,
      serverChannels.map((channel) => channel.id),
    );
    const channelIds = [...visible];
    if (channelIds.length === 0) return { readStates: [] };

    const latest = await db
      .select({ channelId: messages.channelId, lastId: sql<string>`max(${messages.id})` })
      .from(messages)
      .where(and(inArray(messages.channelId, channelIds), eq(messages.deleted, false)))
      .groupBy(messages.channelId);

    const updated: { channelId: string; lastReadMessageId: string }[] = [];
    for (const row of latest) {
      if (!row.lastId) continue;
      await db
        .insert(readStates)
        .values({
          userId,
          channelId: row.channelId,
          lastReadMessageId: row.lastId,
          mentionCount: 0,
          updatedAt: Date.now(),
        })
        .onConflictDoUpdate({
          target: [readStates.userId, readStates.channelId],
          set: { lastReadMessageId: row.lastId, mentionCount: 0, updatedAt: Date.now() },
        });
      updated.push({ channelId: row.channelId, lastReadMessageId: row.lastId });
    }

    return { readStates: updated };
  });

  /** Every channel the user could receive messages in: server channels + open DMs. */
  async function accessibleChannelIds(userId: string): Promise<string[]> {
    const serverIds = (
      await db
        .select({ serverId: members.serverId })
        .from(members)
        .where(eq(members.userId, userId))
    ).map((r) => r.serverId);

    const serverChannels = serverIds.length
      ? await db
          .select({ id: channels.id })
          .from(channels)
          .where(
            and(inArray(channels.serverId, serverIds), eq(channels.type, 'text')),
          )
      : [];

    const dmChannels = await db
      .select({ id: dmParticipants.channelId })
      .from(dmParticipants)
      .where(and(eq(dmParticipants.userId, userId), eq(dmParticipants.closed, false)));

    return [...serverChannels.map((r) => r.id), ...dmChannels.map((r) => r.id)];
  }

  app.patch('/@me/channels/:channelId/mute', async (request) => {
    const { channelId } = request.params as { channelId: string };
    const { muted } = (request.body ?? {}) as { muted?: boolean };

    await db
      .insert(readStates)
      .values({
        userId: request.user!.id,
        channelId,
        muted: muted ?? true,
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: [readStates.userId, readStates.channelId],
        set: { muted: muted ?? true, updatedAt: Date.now() },
      });

    return { ok: true, muted: muted ?? true };
  });

  /* -------------------------------------------------------------------- */
  /* Mutual servers / recent activity                                      */
  /* -------------------------------------------------------------------- */

  app.get('/@me/servers/:serverId/member', async (request) => {
    const { serverId } = request.params as { serverId: string };

    const [row] = await db
      .select()
      .from(members)
      .where(and(eq(members.serverId, serverId), eq(members.userId, request.user!.id)))
      .limit(1);

    if (!row) throw ApiError.notFound('You are not in that server');

    const roleRows = await db
      .select({ roleId: memberRoles.roleId })
      .from(memberRoles)
      .where(
        and(
          eq(memberRoles.serverId, serverId),
          eq(memberRoles.userId, request.user!.id),
        ),
      );

    return {
      member: {
        serverId,
        userId: request.user!.id,
        nickname: row.nickname,
        joinedAt: row.joinedAt,
        roleIds: roleRows.map((r) => r.roleId),
      },
    };
  });

  app.get('/@me/recent-dms', async (request) => {
    const rows = await db
      .select({ channelId: dmParticipants.channelId, lastMessageAt: channels.lastMessageAt })
      .from(dmParticipants)
      .innerJoin(channels, eq(channels.id, dmParticipants.channelId))
      .where(eq(dmParticipants.userId, request.user!.id))
      .orderBy(desc(channels.lastMessageAt))
      .limit(20);

    return { channels: rows };
  });

  /* ---------------------------------------------------------------------- */
  /* Account deletion                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Delete the signed-in account.
   *
   * The row is *tombstoned*, not removed. `messages.author_id` and `servers.owner_id`
   * both cascade, so a real DELETE would erase every message the person ever sent --
   * tearing holes in conversations and orphaning every reply to them -- and destroy any
   * server they owned along with everyone else's history inside it. Deleting your account
   * must not delete other people's.
   *
   * What actually happens: every identifying field is scrubbed and the credential is
   * destroyed, so the account cannot be signed into or recognised, while old messages
   * continue to render as "Deleted User".
   *
   * Servers they own are handled explicitly rather than silently. One with other members
   * belongs to those members too, so the request is refused until ownership is
   * transferred or the server is deleted deliberately.
   */
  app.delete(
    '/@me',
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const parsed = deleteAccountSchema.safeParse(request.body);
      if (!parsed.success) throw fromZodError(parsed.error);

      const userId = request.user!.id;

      const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!user || user.deletedAt !== null) throw ApiError.unauthorized();

      /*
       * Re-authenticate. An unattended session should not be enough to destroy an
       * account -- this is the one action with no undo.
       */
      if (!(await verifyPassword(user.passwordHash, parsed.data.password))) {
        throw ApiError.invalidCredentials('That password is not correct');
      }

      const owned = await db
        .select({ id: servers.id, name: servers.name })
        .from(servers)
        .where(eq(servers.ownerId, userId));

      if (owned.length > 0) {
        const counts = await db
          .select({ serverId: members.serverId, count: sql<number>`count(*)` })
          .from(members)
          .where(
            inArray(
              members.serverId,
              owned.map((s) => s.id),
            ),
          )
          .groupBy(members.serverId);

        const memberCount = new Map(counts.map((row) => [row.serverId, Number(row.count)]));
        const shared = owned.filter((server) => (memberCount.get(server.id) ?? 0) > 1);

        if (shared.length > 0) {
          throw new ApiError(
            409,
            'CONFLICT',
            'Transfer or delete the servers you own first, so their members do not lose them.',
            { servers: shared.map((server) => server.name) },
          );
        }

        // Nobody else is in these, so removing them costs no one anything.
        for (const server of owned) {
          await db.delete(servers).where(eq(servers.id, server.id));
        }
      }

      const now = Date.now();
      /*
       * A per-account suffix, because the scrubbed values still have to satisfy the
       * unique indexes on email and on (username_lower, discriminator). `.invalid` is
       * reserved by RFC 2606 and can never route anywhere.
       */
      const suffix = userId.slice(-10).toLowerCase();

      await db
        .update(users)
        .set({
          email: `deleted+${suffix}@invalid`,
          emailVerifiedAt: null,
          username: `deleted_${suffix}`,
          usernameLower: `deleted_${suffix}`,
          displayName: 'Deleted User',
          // Not a hash of anything: no password can produce this, so the account cannot
          // be signed into even if the tombstone is somehow reached.
          passwordHash: `deleted:${randomBytes(32).toString('hex')}`,
          avatarUrl: null,
          bio: null,
          customStatus: null,
          status: 'offline',
          deletedAt: now,
          updatedAt: now,
        })
        .where(eq(users.id, userId));

      /*
       * Rows that are purely this person's and carry no meaning for anyone else. DM
       * participation is deliberately *not* removed: dropping it would make the
       * conversation vanish for the other party, who is entitled to their own history.
       */
      await db.delete(sessions).where(eq(sessions.userId, userId));
      await db.delete(emailVerifications).where(eq(emailVerifications.userId, userId));
      await db.delete(readStates).where(eq(readStates.userId, userId));
      await db.delete(notifications).where(eq(notifications.userId, userId));
      await db.delete(members).where(eq(members.userId, userId));
      await db
        .delete(friendships)
        .where(or(eq(friendships.requesterId, userId), eq(friendships.addresseeId, userId)));

      request.log.info({ userId }, 'account deleted');

      // Sever every live connection, or the socket would keep acting for a dead account.
      const gateway = app.ctx.gateway;
      if (gateway) {
        for (const socketId of presence.getSocketIds(userId)) {
          gateway.sockets.sockets.get(socketId)?.disconnect(true);
        }
      }

      reply.clearCookie(REFRESH_COOKIE_NAME, clearedRefreshCookieOptions());
      return reply.send({ ok: true });
    },
  );
}
