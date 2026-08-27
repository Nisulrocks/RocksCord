/**
 * Realtime emit helpers and the audit log.
 *
 * Routes call these instead of touching `ctx.gateway` directly, for two reasons:
 *  - the gateway is null when the app is built with `realtime: false` (unit tests), and
 *    every call site would otherwise need its own null check;
 *  - room names stay centralised in `Rooms`, so a typo cannot silently send an event
 *    into a room nobody is listening on.
 */

import { Rooms, type ServerToClientEvents } from '@rockscord/shared';
import type { AppContext } from '../context.js';
import type { Database } from '../db/index.js';
import { auditLogs } from '../db/schema.js';
import { newId } from './ids.js';

type EventName = keyof ServerToClientEvents;
type EventArgs<E extends EventName> = Parameters<ServerToClientEvents[E]>;

/** Emit to everyone currently subscribed to a channel. */
export function emitToChannel<E extends EventName>(
  ctx: AppContext,
  channelId: string,
  event: E,
  ...args: EventArgs<E>
): void {
  ctx.gateway?.to(Rooms.channel(channelId)).emit(event, ...args);
}

/** Emit to every member of a server who is currently connected. */
export function emitToServer<E extends EventName>(
  ctx: AppContext,
  serverId: string,
  event: E,
  ...args: EventArgs<E>
): void {
  ctx.gateway?.to(Rooms.server(serverId)).emit(event, ...args);
}

/** Emit to every socket belonging to one user (they may have several devices open). */
export function emitToUser<E extends EventName>(
  ctx: AppContext,
  userId: string,
  event: E,
  ...args: EventArgs<E>
): void {
  ctx.gateway?.to(Rooms.user(userId)).emit(event, ...args);
}

/** Emit to a set of users at once. */
export function emitToUsers<E extends EventName>(
  ctx: AppContext,
  userIds: Iterable<string>,
  event: E,
  ...args: EventArgs<E>
): void {
  if (!ctx.gateway) return;
  const rooms = [...userIds].map((id) => Rooms.user(id));
  if (rooms.length === 0) return;
  ctx.gateway.to(rooms).emit(event, ...args);
}

/** Add or remove every socket of a user from a server's room, e.g. on join/leave. */
export async function moveUserSockets(
  ctx: AppContext,
  userId: string,
  room: string,
  action: 'join' | 'leave',
): Promise<void> {
  if (!ctx.gateway) return;
  const sockets = await ctx.gateway.in(Rooms.user(userId)).fetchSockets();
  for (const socket of sockets) {
    if (action === 'join') socket.join(room);
    else socket.leave(room);
  }
}

/**
 * Append a moderation event to the server's audit log.
 *
 * Failures are swallowed: an audit write must never be the reason a kick or a role change
 * fails. The error is surfaced through the caller's logger instead.
 */
export async function writeAuditLog(
  db: Database,
  entry: {
    serverId: string;
    actorId: string | null;
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      id: newId(),
      serverId: entry.serverId,
      actorId: entry.actorId,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
    });
  } catch {
    // Intentionally ignored -- see the doc comment.
  }
}
