/**
 * User routes.
 *
 *   GET   /api/users/:userId          public profile
 *   PATCH /api/users/@me              update own profile
 *   GET   /api/users/@me/read-states  unread + mention state for every channel
 *   PATCH /api/users/@me/channels/:channelId/mute  mute or unmute a channel
 *
 * There is deliberately no "list all users" endpoint. Discovery happens through servers
 * you share, friends, and explicit username search -- not by enumerating the database.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { LIMITS, updateProfileSchema } from '@rockscord/shared';
import {
  channels,
  dmParticipants,
  memberRoles,
  members,
  messages,
  readStates,
  users,
} from '../db/schema.js';
import { ApiError, fromZodError } from '../lib/errors.js';
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
}
