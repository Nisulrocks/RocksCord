/**
 * Presence registry.
 *
 * Who is online is inherently ephemeral state, so it lives in memory rather than in the
 * database: writing a row on every connect/disconnect would be pure write amplification
 * against Turso's free-tier write quota, and the data is worthless after a restart anyway.
 *
 * A user can have several sockets at once (desktop app + browser tab + phone). The
 * registry therefore reference-counts connections per user, and only reports a user as
 * offline when their *last* socket goes away.
 *
 * Scaling note: this is per-process state. Running more than one server instance would
 * need the Socket.IO Redis adapter and a shared presence store. That is deliberately out
 * of scope -- every free tier this targets runs exactly one instance.
 */

import type { UserStatus } from '@rockscord/shared';

interface PresenceEntry {
  socketIds: Set<string>;
  /** The status the user chose. Never 'offline' while they have a socket. */
  status: UserStatus;
  customStatus: string | null;
  lastActiveAt: number;
}

const entries = new Map<string, PresenceEntry>();

/** Map socket id -> user id, so a disconnect can be resolved without a scan. */
const socketOwners = new Map<string, string>();

export interface PresenceSnapshot {
  userId: string;
  status: UserStatus;
  customStatus: string | null;
}

/**
 * Register a socket for a user.
 * Returns true when this was the user's first connection (i.e. they just came online),
 * which is the signal to broadcast a presence update.
 */
export function addSocket(
  userId: string,
  socketId: string,
  status: UserStatus = 'online',
  customStatus: string | null = null,
): boolean {
  socketOwners.set(socketId, userId);

  const existing = entries.get(userId);
  if (existing) {
    existing.socketIds.add(socketId);
    existing.lastActiveAt = Date.now();
    // A second connection should not silently override a chosen 'dnd' or 'idle'.
    if (existing.status === 'offline') existing.status = status;
    return false;
  }

  entries.set(userId, {
    socketIds: new Set([socketId]),
    status: status === 'offline' ? 'online' : status,
    customStatus,
    lastActiveAt: Date.now(),
  });
  return true;
}

/**
 * Unregister a socket.
 * Returns the user id when that user has now gone fully offline, otherwise null.
 */
export function removeSocket(socketId: string): string | null {
  const userId = socketOwners.get(socketId);
  if (!userId) return null;
  socketOwners.delete(socketId);

  const entry = entries.get(userId);
  if (!entry) return null;

  entry.socketIds.delete(socketId);
  if (entry.socketIds.size > 0) return null;

  entries.delete(userId);
  return userId;
}

/** Change a user's chosen status. Returns false if they have no active connection. */
export function setStatus(
  userId: string,
  status: UserStatus,
  customStatus?: string | null,
): boolean {
  const entry = entries.get(userId);
  if (!entry) return false;
  entry.status = status;
  if (customStatus !== undefined) entry.customStatus = customStatus;
  entry.lastActiveAt = Date.now();
  return true;
}

/**
 * A user's effective status.
 *
 * 'offline' is not stored -- it is the absence of an entry. This is what makes presence
 * correct after a crash: a restarted process has an empty map, so everyone is offline,
 * which is exactly true.
 */
export function getStatus(userId: string): UserStatus {
  return entries.get(userId)?.status ?? 'offline';
}

export function getCustomStatus(userId: string): string | null {
  return entries.get(userId)?.customStatus ?? null;
}

export function isOnline(userId: string): boolean {
  return entries.has(userId);
}

export function getSnapshot(userId: string): PresenceSnapshot {
  const entry = entries.get(userId);
  return {
    userId,
    status: entry?.status ?? 'offline',
    customStatus: entry?.customStatus ?? null,
  };
}

/** Presence for a set of users. Used to build the initial ready payload. */
export function getSnapshots(userIds: Iterable<string>): PresenceSnapshot[] {
  const out: PresenceSnapshot[] = [];
  for (const userId of userIds) out.push(getSnapshot(userId));
  return out;
}

/** Every socket id belonging to a user, for targeted emits. */
export function getSocketIds(userId: string): string[] {
  return [...(entries.get(userId)?.socketIds ?? [])];
}

export function onlineUserCount(): number {
  return entries.size;
}

/** Test hook: drop all presence state. */
export function resetPresence(): void {
  entries.clear();
  socketOwners.clear();
}
