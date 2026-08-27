/**
 * Socket.IO gateway.
 *
 * Connection lifecycle:
 *   1. Handshake carries the same JWT access token the REST API uses. An unauthenticated
 *      socket is rejected in middleware and never reaches a handler -- there is no
 *      "connect first, authenticate later" window.
 *   2. On connect the socket joins its personal room, one room per server it belongs to,
 *      and a room per DM. Room membership *is* the authorisation model for broadcasts:
 *      if you are not in the room, the event is never serialised for you.
 *   3. A `ready` payload is pushed immediately with everything needed to render the app,
 *      so the client does not open with a waterfall of REST calls.
 *   4. On disconnect, presence is decremented and any voice channel is vacated.
 *
 * Transport note: Socket.IO negotiates WebSocket but falls back to HTTP long-polling
 * automatically. That fallback is why this design survives on hosts that do not proxy
 * WebSocket upgrades correctly -- messaging degrades in latency, not in function.
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { Server as SocketServer } from 'socket.io';
import {
  Permission,
  Rooms,
  TYPING_TIMEOUT_MS,
  hasPermission,
  type ReadyPayload,
} from '@rockscord/shared';
import { env } from '../env.js';
import type { AppContext, Gateway, SocketData } from '../context.js';
import {
  channels,
  dmParticipants,
  memberRoles,
  members,
  messages,
  readStates,
  roles,
  servers,
  users,
} from '../db/schema.js';
import { verifyAccessToken } from '../lib/auth.js';
import { filterVisibleChannels, getChannelPermissionContext, getMemberContext } from '../lib/permissions.js';
import {
  loadDMChannels,
  publicUserColumns,
  toChannel,
  toRole,
  toSelfUser,
  toServer,
} from '../lib/serializers.js';
import { acknowledgeChannel } from '../lib/notifications.js';
import * as presence from './presence.js';
import {
  getAllVoiceStates,
  getUserVoiceChannel,
  getVoicePeerIds,
  hydrateVoiceStates,
  joinVoice,
  leaveVoice,
  updateVoiceState,
} from './voice.js';
import type { Database } from '../db/index.js';

/**
 * Per-socket typing throttle. A client that spams `typing:start` on every keystroke gets
 * its events collapsed here rather than fanning out to every other member.
 */
const lastTypingAt = new Map<string, number>();
const TYPING_THROTTLE_MS = 2000;

/** Build the payload the client needs to render its entire shell in one round trip. */
async function buildReadyPayload(db: Database, userId: string): Promise<ReadyPayload> {
  const [userRow] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!userRow) throw new Error('user vanished during handshake');

  const memberships = await db
    .select({ serverId: members.serverId, nickname: members.nickname })
    .from(members)
    .where(eq(members.userId, userId));

  const serverIds = memberships.map((m) => m.serverId);

  const serverRows = serverIds.length
    ? await db.select().from(servers).where(inArray(servers.id, serverIds))
    : [];

  const counts = serverIds.length
    ? await db
        .select({ serverId: members.serverId, count: sql<number>`count(*)` })
        .from(members)
        .where(inArray(members.serverId, serverIds))
        .groupBy(members.serverId)
    : [];
  const countMap = new Map(counts.map((c) => [c.serverId, Number(c.count)]));

  const roleRows = serverIds.length
    ? await db.select().from(roles).where(inArray(roles.serverId, serverIds))
    : [];

  const memberRoleRows = serverIds.length
    ? await db
        .select({ serverId: memberRoles.serverId, roleId: memberRoles.roleId })
        .from(memberRoles)
        .where(and(eq(memberRoles.userId, userId), inArray(memberRoles.serverId, serverIds)))
    : [];

  const roleIdsByServer = new Map<string, string[]>();
  for (const row of memberRoleRows) {
    const list = roleIdsByServer.get(row.serverId) ?? [];
    list.push(row.roleId);
    roleIdsByServer.set(row.serverId, list);
  }

  // Channels are filtered per server so private channels never appear in the sidebar.
  const allChannelRows = serverIds.length
    ? await db
        .select()
        .from(channels)
        .where(inArray(channels.serverId, serverIds))
        .orderBy(asc(channels.position), asc(channels.id))
    : [];

  const visibleChannels = [];
  for (const serverId of serverIds) {
    const context = await getMemberContext(db, serverId, userId);
    if (!context) continue;
    const forServer = allChannelRows.filter((c) => c.serverId === serverId);
    const visible = await filterVisibleChannels(
      db,
      context,
      forServer.map((c) => c.id),
    );
    for (const channel of forServer) {
      if (visible.has(channel.id)) visibleChannels.push(channel);
    }
  }

  const dmChannels = await loadDMChannels(db, userId);

  // Friends: accepted relationships plus pending requests in both directions.
  const friendRows = await db.all<{
    id: string;
    status: 'pending' | 'accepted' | 'blocked';
    requester_id: string;
    created_at: number;
    other_id: string;
  }>(sql`
    SELECT id, status, requester_id, created_at,
           CASE WHEN requester_id = ${userId} THEN addressee_id ELSE requester_id END AS other_id
    FROM friendships
    WHERE requester_id = ${userId} OR addressee_id = ${userId}
  `);

  const friendUserIds = friendRows.map((r) => r.other_id);
  const friendUsers = friendUserIds.length
    ? await db.select(publicUserColumns).from(users).where(inArray(users.id, friendUserIds))
    : [];
  const friendUserMap = new Map(friendUsers.map((u) => [u.id, u]));

  const friends = friendRows
    .filter((row) => friendUserMap.has(row.other_id))
    .map((row) => ({
      id: row.id,
      status: row.status,
      requesterId: row.requester_id,
      createdAt: row.created_at,
      user: {
        ...friendUserMap.get(row.other_id)!,
        status: presence.getStatus(row.other_id),
        customStatus: presence.getCustomStatus(row.other_id),
      },
    }));

  // Read states, with the derived `unread` flag computed the same way as the REST route.
  const readRows = await db.select().from(readStates).where(eq(readStates.userId, userId));
  const trackedChannelIds = [
    ...visibleChannels.filter((c) => c.type === 'text').map((c) => c.id),
    ...dmChannels.map((c) => c.id),
  ];

  const latestRows = trackedChannelIds.length
    ? await db
        .select({ channelId: messages.channelId, lastId: sql<string>`max(${messages.id})` })
        .from(messages)
        .where(and(inArray(messages.channelId, trackedChannelIds), eq(messages.deleted, false)))
        .groupBy(messages.channelId)
    : [];

  const latestMap = new Map(latestRows.map((r) => [r.channelId, r.lastId]));
  const readMap = new Map(readRows.map((r) => [r.channelId, r]));

  const readStatePayload = trackedChannelIds.map((channelId) => {
    const state = readMap.get(channelId);
    const newest = latestMap.get(channelId) ?? null;
    const lastRead = state?.lastReadMessageId ?? null;
    return {
      channelId,
      lastReadMessageId: lastRead,
      mentionCount: state?.mentionCount ?? 0,
      unread: Boolean(newest) && (!lastRead || newest! > lastRead),
    };
  });

  // Presence for everyone this user can see.
  const coMemberRows = serverIds.length
    ? await db
        .select({ userId: members.userId })
        .from(members)
        .where(inArray(members.serverId, serverIds))
    : [];

  const visibleUserIds = new Set<string>([
    // Yourself, always. Otherwise an account in no servers has no presence entry of its
    // own to render, and its status indicator falls back to a hard-coded "online".
    userId,
    ...coMemberRows.map((r) => r.userId),
    ...friendUserIds,
    ...dmChannels.flatMap((c) => c.recipients.map((r) => r.id)),
  ]);

  const voiceStates = await hydrateVoiceStates(db, getAllVoiceStates());

  return {
    user: toSelfUser(userRow),
    servers: serverRows.map((row) => toServer(row, countMap.get(row.id) ?? 0)),
    channels: visibleChannels.map((row) => toChannel(row)),
    roles: roleRows.map(toRole),
    memberships: memberships.map((m) => ({
      serverId: m.serverId,
      nickname: m.nickname,
      roleIds: roleIdsByServer.get(m.serverId) ?? [],
    })),
    dmChannels,
    friends,
    readStates: readStatePayload,
    voiceStates,
    presences: presence.getSnapshots(visibleUserIds),
  };
}

export function attachGateway(app: FastifyInstance, ctx: AppContext): Gateway {
  const { db } = ctx;

  const io: Gateway = new SocketServer(app.server, {
    cors: { origin: env.corsOrigins === true ? true : env.corsOrigins, credentials: true },
    // Polling first, then upgrade. Keeping polling available is what lets the app work
    // on hosts and networks that block WebSocket upgrades.
    transports: ['polling', 'websocket'],
    pingInterval: 25000,
    pingTimeout: 20000,
    maxHttpBufferSize: 1e6,
    path: '/socket.io',
  });

  /* ---------------------------------------------------------------------- */
  /* Authentication                                                          */
  /* ---------------------------------------------------------------------- */

  io.use(async (socket, next) => {
    try {
      const token =
        (socket.handshake.auth?.token as string | undefined) ??
        (socket.handshake.headers.authorization?.replace(/^Bearer\s+/i, '') ?? undefined);

      if (!token) return next(new Error('UNAUTHORIZED'));

      const claims = await verifyAccessToken(token);
      if (!claims) return next(new Error('UNAUTHORIZED'));

      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, claims.sub))
        .limit(1);
      if (!user) return next(new Error('UNAUTHORIZED'));

      const memberships = await db
        .select({ serverId: members.serverId })
        .from(members)
        .where(eq(members.userId, user.id));

      const data: SocketData = {
        userId: user.id,
        sessionId: claims.sid,
        serverIds: memberships.map((m) => m.serverId),
      };
      Object.assign(socket.data, data);

      next();
    } catch (error) {
      app.log.error({ err: error }, 'socket authentication failed');
      next(new Error('UNAUTHORIZED'));
    }
  });

  /* ---------------------------------------------------------------------- */
  /* Connection                                                              */
  /* ---------------------------------------------------------------------- */

  io.on('connection', async (socket) => {
    const { userId } = socket.data;

    socket.join(Rooms.user(userId));
    for (const serverId of socket.data.serverIds) socket.join(Rooms.server(serverId));

    const dmRows = await db
      .select({ channelId: dmParticipants.channelId })
      .from(dmParticipants)
      .where(eq(dmParticipants.userId, userId));
    for (const dm of dmRows) socket.join(Rooms.channel(dm.channelId));

    // Restore the status the user last chose rather than forcing everyone to 'online'.
    const [userRow] = await db
      .select({ status: users.status, customStatus: users.customStatus })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const cameOnline = presence.addSocket(
      userId,
      socket.id,
      userRow?.status ?? 'online',
      userRow?.customStatus ?? null,
    );

    try {
      socket.emit('ready', await buildReadyPayload(db, userId));
    } catch (error) {
      app.log.error({ err: error, userId }, 'failed to build ready payload');
      socket.emit('gateway:error', {
        code: 'READY_FAILED',
        message: 'Could not load your account state. Try reconnecting.',
      });
    }

    if (cameOnline) {
      const snapshot = presence.getSnapshot(userId);
      // Only people who can see this user get told about it.
      for (const serverId of socket.data.serverIds) {
        io.to(Rooms.server(serverId)).emit('presence:update', snapshot);
      }
      for (const dm of dmRows) io.to(Rooms.channel(dm.channelId)).emit('presence:update', snapshot);
    }

    await db.update(users).set({ lastSeenAt: Date.now() }).where(eq(users.id, userId));

    /* -------------------------------------------------------------------- */
    /* Channel subscription                                                  */
    /* -------------------------------------------------------------------- */

    socket.on('channel:subscribe', async ({ channelId }) => {
      try {
        // Subscribing is a permission check, not a formality: it is what stops a client
        // from joining an arbitrary room and receiving messages it should not see.
        const context = await getChannelPermissionContext(db, channelId, userId);
        if (!hasPermission(context.channelPermissions, Permission.VIEW_CHANNEL)) {
          socket.emit('gateway:error', {
            code: 'FORBIDDEN',
            message: 'You cannot view that channel',
          });
          return;
        }
        socket.join(Rooms.channel(channelId));
      } catch {
        socket.emit('gateway:error', { code: 'NOT_FOUND', message: 'Channel not found' });
      }
    });

    socket.on('channel:unsubscribe', ({ channelId }) => {
      // DM rooms are joined for the lifetime of the connection so DMs still notify when
      // the conversation is not open; leaving them here would break that.
      const isDm = dmRows.some((dm) => dm.channelId === channelId);
      if (!isDm) socket.leave(Rooms.channel(channelId));
    });

    /* -------------------------------------------------------------------- */
    /* Typing                                                                */
    /* -------------------------------------------------------------------- */

    socket.on('typing:start', async ({ channelId }) => {
      const key = `${socket.id}:${channelId}`;
      const now = Date.now();
      if (now - (lastTypingAt.get(key) ?? 0) < TYPING_THROTTLE_MS) return;
      lastTypingAt.set(key, now);

      try {
        const context = await getChannelPermissionContext(db, channelId, userId);
        if (!hasPermission(context.channelPermissions, Permission.SEND_MESSAGES)) return;

        const [profile] = await db
          .select({ displayName: users.displayName })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);

        // `socket.to(...)` excludes the sender -- you never see your own typing indicator.
        socket.to(Rooms.channel(channelId)).emit('typing:start', {
          channelId,
          userId,
          username: profile?.displayName ?? 'Someone',
        });
      } catch {
        // A typing event for a channel that vanished is not worth reporting.
      }
    });

    /* -------------------------------------------------------------------- */
    /* Presence                                                              */
    /* -------------------------------------------------------------------- */

    socket.on('presence:set', async ({ status, customStatus }) => {
      presence.setStatus(userId, status, customStatus);
      await db
        .update(users)
        .set({
          status,
          ...(customStatus === undefined ? {} : { customStatus }),
          updatedAt: Date.now(),
        })
        .where(eq(users.id, userId));

      const snapshot = presence.getSnapshot(userId);

      /*
       * Your own sockets first, and unconditionally.
       *
       * The broadcasts below reach shared rooms, so someone in no servers and no DMs used
       * to change their status and see nothing happen -- the update was sent to an
       * audience of nobody, including themselves. It also keeps a second tab or the
       * desktop app in step, which shared-room delivery only did by coincidence.
       */
      io.to(Rooms.user(userId)).emit('presence:update', snapshot);

      for (const serverId of socket.data.serverIds) {
        io.to(Rooms.server(serverId)).emit('presence:update', snapshot);
      }
      for (const dm of dmRows) io.to(Rooms.channel(dm.channelId)).emit('presence:update', snapshot);
    });

    /* -------------------------------------------------------------------- */
    /* Read acknowledgement                                                  */
    /* -------------------------------------------------------------------- */

    socket.on('read:ack', async ({ channelId, messageId }) => {
      try {
        await getChannelPermissionContext(db, channelId, userId);
        await acknowledgeChannel(db, userId, channelId, messageId);
      } catch {
        // Acking a channel you have lost access to is harmless; ignore it.
      }
    });

    /* -------------------------------------------------------------------- */
    /* Voice                                                                 */
    /* -------------------------------------------------------------------- */

    socket.on('voice:join', async ({ channelId }) => {
      try {
        const context = await getChannelPermissionContext(db, channelId, userId);
        if (!hasPermission(context.channelPermissions, Permission.CONNECT)) {
          socket.emit('gateway:error', {
            code: 'FORBIDDEN',
            message: 'You cannot join that voice channel',
          });
          return;
        }

        const [channel] = await db
          .select({ type: channels.type })
          .from(channels)
          .where(eq(channels.id, channelId))
          .limit(1);

        if (!channel || (channel.type !== 'voice' && channel.type !== 'dm')) {
          socket.emit('gateway:error', {
            code: 'BAD_REQUEST',
            message: 'That is not a voice channel',
          });
          return;
        }

        const { previousChannelId, state } = joinVoice(userId, channelId);

        if (previousChannelId && previousChannelId !== channelId) {
          socket.leave(Rooms.voice(previousChannelId));
          io.to(Rooms.voice(previousChannelId)).emit('voice:leave', {
            channelId: previousChannelId,
            userId,
          });
        }

        socket.join(Rooms.voice(channelId));

        const [participant] = await hydrateVoiceStates(db, [state]);
        if (participant) {
          // Existing peers learn about the newcomer and initiate offers toward them.
          io.to(Rooms.voice(channelId)).emit('voice:join', participant);
          if (context.serverId) {
            io.to(Rooms.server(context.serverId)).emit('voice:join', participant);
          }
        }
      } catch (error) {
        app.log.warn({ err: error, userId, channelId }, 'voice join failed');
        socket.emit('gateway:error', { code: 'NOT_FOUND', message: 'Channel not found' });
      }
    });

    socket.on('voice:leave', async () => {
      const channelId = leaveVoice(userId);
      if (!channelId) return;
      socket.leave(Rooms.voice(channelId));
      io.to(Rooms.voice(channelId)).emit('voice:leave', { channelId, userId });

      const [channel] = await db
        .select({ serverId: channels.serverId })
        .from(channels)
        .where(eq(channels.id, channelId))
        .limit(1);
      if (channel?.serverId) {
        io.to(Rooms.server(channel.serverId)).emit('voice:leave', { channelId, userId });
      }
    });

    socket.on('voice:state', async (patch) => {
      const next = updateVoiceState(userId, patch);
      if (!next) return;

      const [participant] = await hydrateVoiceStates(db, [next]);
      if (!participant) return;

      io.to(Rooms.voice(next.channelId)).emit('voice:update', participant);

      const [channel] = await db
        .select({ serverId: channels.serverId })
        .from(channels)
        .where(eq(channels.id, next.channelId))
        .limit(1);
      if (channel?.serverId) {
        io.to(Rooms.server(channel.serverId)).emit('voice:update', participant);
      }
    });

    /**
     * WebRTC signalling relay.
     *
     * The payload is opaque to the server -- it is an SDP offer/answer or an ICE
     * candidate that only the two peers understand. What the server *does* enforce is
     * that both parties are currently in the same voice channel, so signalling cannot be
     * used as an unmoderated side channel to arbitrary users.
     */
    socket.on('voice:signal', ({ peerId, channelId, data }) => {
      const myChannel = getUserVoiceChannel(userId);
      if (!myChannel || myChannel !== channelId) return;
      if (!getVoicePeerIds(channelId).includes(peerId)) return;

      io.to(Rooms.user(peerId)).emit('voice:signal', {
        peerId: userId,
        channelId,
        data,
      });
    });

    /* -------------------------------------------------------------------- */
    /* Disconnect                                                            */
    /* -------------------------------------------------------------------- */

    socket.on('disconnect', async (reason) => {
      for (const key of lastTypingAt.keys()) {
        if (key.startsWith(`${socket.id}:`)) lastTypingAt.delete(key);
      }

      const voiceChannelId = getUserVoiceChannel(userId);
      const remainingSockets = presence.getSocketIds(userId).filter((id) => id !== socket.id);

      // Only vacate voice when the user's *last* socket goes; a second tab closing
      // should not drop them from a call.
      if (voiceChannelId && remainingSockets.length === 0) {
        leaveVoice(userId);
        io.to(Rooms.voice(voiceChannelId)).emit('voice:leave', {
          channelId: voiceChannelId,
          userId,
        });
        const [channel] = await db
          .select({ serverId: channels.serverId })
          .from(channels)
          .where(eq(channels.id, voiceChannelId))
          .limit(1);
        if (channel?.serverId) {
          io.to(Rooms.server(channel.serverId)).emit('voice:leave', {
            channelId: voiceChannelId,
            userId,
          });
        }
      }

      const wentOffline = presence.removeSocket(socket.id);
      if (wentOffline) {
        const snapshot = { userId, status: 'offline' as const, customStatus: null };
        for (const serverId of socket.data.serverIds) {
          io.to(Rooms.server(serverId)).emit('presence:update', snapshot);
        }
        for (const dm of dmRows) {
          io.to(Rooms.channel(dm.channelId)).emit('presence:update', snapshot);
        }
        await db.update(users).set({ lastSeenAt: Date.now() }).where(eq(users.id, userId));
      }

      app.log.debug({ userId, reason }, 'socket disconnected');
    });
  });

  app.log.info('realtime gateway attached');
  return io;
}

export { TYPING_TIMEOUT_MS };
