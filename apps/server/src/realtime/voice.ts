/**
 * Voice channel state.
 *
 * Like presence, who is sitting in a voice channel is ephemeral and lives in memory. A
 * process restart correctly empties every voice channel, because the WebRTC peer
 * connections died with it anyway.
 *
 * This module tracks *membership and mute state only*. The media path is a full mesh of
 * direct peer connections between clients: each participant sends their audio to every
 * other participant. The server's only role is routing offer/answer/ICE messages between
 * peers, which is why voice costs nothing to host.
 *
 * The mesh is O(n^2) in connections, so it is practical to roughly 6-8 people per channel
 * (`LIMITS.VOICE_CHANNEL_SOFT_CAP`). Going beyond that needs an SFU, which needs a paid
 * always-on server -- explicitly out of scope for a $0 build.
 */

import { inArray } from 'drizzle-orm';
import type { VoiceParticipant } from '@rockscord/shared';
import type { Database } from '../db/index.js';
import { users } from '../db/schema.js';
import { publicUserColumns, toPublicUser } from '../lib/serializers.js';

export interface VoiceState {
  userId: string;
  channelId: string;
  selfMute: boolean;
  selfDeaf: boolean;
  serverMute: boolean;
  serverDeaf: boolean;
  streaming: boolean;
  camera: boolean;
  joinedAt: number;
}

/** channelId -> userId -> state */
const channelStates = new Map<string, Map<string, VoiceState>>();

/** userId -> channelId, so we can find (and vacate) a user's current channel in O(1). */
const userChannel = new Map<string, string>();

/**
 * Put a user into a voice channel.
 * Returns the previous channel they were in, if any, so the caller can announce the
 * departure -- a user can only be in one voice channel at a time, like a phone call.
 */
export function joinVoice(userId: string, channelId: string): { previousChannelId: string | null; state: VoiceState } {
  const previousChannelId = userChannel.get(userId) ?? null;
  if (previousChannelId && previousChannelId !== channelId) {
    leaveVoice(userId);
  }

  const state: VoiceState = {
    userId,
    channelId,
    selfMute: false,
    selfDeaf: false,
    serverMute: false,
    serverDeaf: false,
    streaming: false,
    camera: false,
    joinedAt: Date.now(),
  };

  const states = channelStates.get(channelId) ?? new Map<string, VoiceState>();
  // Rejoining the same channel (e.g. after a reconnect) keeps the existing mute settings.
  const existing = states.get(userId);
  states.set(userId, existing ? { ...existing, channelId } : state);
  channelStates.set(channelId, states);
  userChannel.set(userId, channelId);

  return { previousChannelId, state: states.get(userId)! };
}

/** Remove a user from whatever voice channel they are in. Returns the channel id. */
export function leaveVoice(userId: string): string | null {
  const channelId = userChannel.get(userId);
  if (!channelId) return null;

  const states = channelStates.get(channelId);
  states?.delete(userId);
  if (states && states.size === 0) channelStates.delete(channelId);
  userChannel.delete(userId);

  return channelId;
}

/**
 * Apply a mute/deafen/streaming/camera change. Returns the new state, or null if the user
 * is not in a voice channel.
 *
 * Undefined entries in the patch are ignored rather than assigned. Spreading them would
 * write `undefined` over a real boolean, so callers that build a patch by picking a few
 * optional fields -- which is exactly what the socket handler does -- would silently
 * clear everything they did not mention.
 */
export function updateVoiceState(
  userId: string,
  patch: Partial<
    Pick<VoiceState, 'selfMute' | 'selfDeaf' | 'streaming' | 'camera' | 'serverMute' | 'serverDeaf'>
  >,
): VoiceState | null {
  const channelId = userChannel.get(userId);
  if (!channelId) return null;

  const states = channelStates.get(channelId);
  const existing = states?.get(userId);
  if (!existing || !states) return null;

  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );
  const next: VoiceState = { ...existing, ...defined };

  // Deafening implies muting: you cannot sensibly transmit while hearing nothing, and
  // every voice client users are familiar with behaves this way.
  if (next.selfDeaf) next.selfMute = true;

  states.set(userId, next);
  return next;
}

export function getUserVoiceChannel(userId: string): string | null {
  return userChannel.get(userId) ?? null;
}

/** Raw states for a channel, without database hydration. */
export function getVoiceStates(channelId: string): VoiceState[] {
  return [...(channelStates.get(channelId)?.values() ?? [])];
}

/** Every user id currently in a given voice channel. */
export function getVoicePeerIds(channelId: string, excludeUserId?: string): string[] {
  return getVoiceStates(channelId)
    .map((s) => s.userId)
    .filter((id) => id !== excludeUserId);
}

/** All voice states across all channels, for the initial ready payload. */
export function getAllVoiceStates(): VoiceState[] {
  const out: VoiceState[] = [];
  for (const states of channelStates.values()) out.push(...states.values());
  return out;
}

/** Hydrate voice states into full DTOs with user profiles attached. */
export async function hydrateVoiceStates(
  db: Database,
  states: readonly VoiceState[],
): Promise<VoiceParticipant[]> {
  if (states.length === 0) return [];

  const rows = await db
    .select(publicUserColumns)
    .from(users)
    .where(inArray(users.id, [...new Set(states.map((s) => s.userId))]));

  const userMap = new Map(rows.map((row) => [row.id, row]));

  return states
    .filter((state) => userMap.has(state.userId))
    .map((state) => ({
      userId: state.userId,
      channelId: state.channelId,
      user: toPublicUser(userMap.get(state.userId)!),
      selfMute: state.selfMute,
      selfDeaf: state.selfDeaf,
      serverMute: state.serverMute,
      serverDeaf: state.serverDeaf,
      streaming: state.streaming,
      camera: state.camera,
      joinedAt: state.joinedAt,
    }));
}

export async function getVoiceParticipants(
  db: Database,
  channelId: string,
): Promise<VoiceParticipant[]> {
  return hydrateVoiceStates(db, getVoiceStates(channelId));
}

/** Test hook: clear all voice state. */
export function resetVoice(): void {
  channelStates.clear();
  userChannel.clear();
}
