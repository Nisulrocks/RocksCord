/**
 * Realtime gateway contract.
 *
 * `ServerToClientEvents` and `ClientToServerEvents` are handed to Socket.IO's generics on
 * both ends, so a typo in an event name or payload is a compile error rather than a
 * message that silently goes nowhere.
 */

import type {
  Channel,
  DMChannel,
  Friendship,
  Member,
  Message,
  ReadyPayload,
  Role,
  Server,
  UserStatus,
  VoiceParticipant,
} from './types.js';

export interface TypingPayload {
  channelId: string;
  userId: string;
  username: string;
}

export interface PresenceUpdate {
  userId: string;
  status: UserStatus;
  customStatus: string | null;
}

/** Sent when a message the client already has is mutated in place. */
export interface MessageUpdatePayload {
  message: Message;
}

export interface MessageDeletePayload {
  channelId: string;
  messageId: string;
}

export interface ReactionPayload {
  channelId: string;
  messageId: string;
  emoji: string;
  userId: string;
}

/** WebRTC signalling. The server never inspects `data`; it only routes it. */
export interface SignalPayload {
  /** The peer this signal is addressed to (or came from). */
  peerId: string;
  channelId: string;
  data: unknown;
}

export interface VoiceStateUpdatePayload {
  selfMute?: boolean;
  selfDeaf?: boolean;
  streaming?: boolean;
}

export interface NotificationPayload {
  id: string;
  type: 'mention' | 'dm' | 'friend_request' | 'server_invite';
  title: string;
  body: string;
  channelId: string | null;
  serverId: string | null;
  messageId: string | null;
  createdAt: number;
}

export interface ServerToClientEvents {
  /** Fired once after a successful handshake. Contains the whole initial state. */
  ready: (payload: ReadyPayload) => void;

  'message:create': (message: Message) => void;
  'message:update': (payload: MessageUpdatePayload) => void;
  'message:delete': (payload: MessageDeletePayload) => void;
  'message:reaction:add': (payload: ReactionPayload) => void;
  'message:reaction:remove': (payload: ReactionPayload) => void;

  'typing:start': (payload: TypingPayload) => void;

  'presence:update': (payload: PresenceUpdate) => void;

  'server:create': (server: Server) => void;
  'server:update': (server: Server) => void;
  'server:delete': (payload: { serverId: string }) => void;

  'channel:create': (channel: Channel) => void;
  'channel:update': (channel: Channel) => void;
  'channel:delete': (payload: { serverId: string; channelId: string }) => void;

  'member:join': (member: Member) => void;
  'member:update': (member: Member) => void;
  'member:leave': (payload: { serverId: string; userId: string }) => void;

  'role:create': (role: Role) => void;
  'role:update': (role: Role) => void;
  'role:delete': (payload: { serverId: string; roleId: string }) => void;

  'dm:create': (channel: DMChannel) => void;

  'friend:request': (friendship: Friendship) => void;
  'friend:update': (friendship: Friendship) => void;
  'friend:remove': (payload: { userId: string }) => void;

  'voice:join': (participant: VoiceParticipant) => void;
  'voice:leave': (payload: { channelId: string; userId: string }) => void;
  'voice:update': (participant: VoiceParticipant) => void;
  /** Routed WebRTC offer/answer/ICE from another peer. */
  'voice:signal': (payload: SignalPayload) => void;

  notification: (payload: NotificationPayload) => void;

  /** Sent instead of disconnecting silently, so the UI can explain what happened. */
  'gateway:error': (payload: { code: string; message: string }) => void;
}

export interface ClientToServerEvents {
  /** Join the socket room for a channel so message events start arriving. */
  'channel:subscribe': (payload: { channelId: string }) => void;
  'channel:unsubscribe': (payload: { channelId: string }) => void;

  'typing:start': (payload: { channelId: string }) => void;

  'presence:set': (payload: { status: UserStatus; customStatus?: string | null }) => void;

  /** Mark a channel read up to a message; clears its unread dot and mention badge. */
  'read:ack': (payload: { channelId: string; messageId: string }) => void;

  'voice:join': (payload: { channelId: string }) => void;
  'voice:leave': () => void;
  'voice:state': (payload: VoiceStateUpdatePayload) => void;
  'voice:signal': (payload: SignalPayload) => void;
}

/** Socket.IO room naming. Centralised so the server never builds a room string ad hoc. */
export const Rooms = {
  user: (userId: string) => `user:${userId}`,
  server: (serverId: string) => `server:${serverId}`,
  channel: (channelId: string) => `channel:${channelId}`,
  voice: (channelId: string) => `voice:${channelId}`,
} as const;

/** How long a typing indicator stays visible without a refresh, in milliseconds. */
export const TYPING_TIMEOUT_MS = 8000;
