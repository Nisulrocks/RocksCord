/**
 * Realtime connection.
 *
 * The socket is a module-level singleton rather than React state: it must survive route
 * changes and re-renders, and exactly one connection per tab is correct. Handlers write
 * straight into the Zustand store, so components subscribe to data and never to the
 * socket itself.
 *
 * Reconnection is Socket.IO's, with one addition: because the handshake carries a
 * 15-minute access token, a reconnect after a long sleep would fail authentication. So
 * before every attempt the token is refreshed, which is what makes closing a laptop lid
 * for an hour and reopening it Just Work.
 */

import { io, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  UserStatus,
} from '@rockscord/shared';
import { API_BASE, getAccessToken, refreshAccessToken } from './api';
import { useAppStore } from '../store/useAppStore';
import { handleVoiceSignal, handleVoicePeerLeft } from './voice';

export type RocksCordSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: RocksCordSocket | null = null;

export function getSocket(): RocksCordSocket | null {
  return socket;
}

/** Open the realtime connection. Safe to call repeatedly; later calls are no-ops. */
export function connectSocket(): RocksCordSocket {
  if (socket?.connected || socket?.active) return socket;

  const store = useAppStore.getState();

  socket = io(API_BASE || window.location.origin, {
    auth: { token: getAccessToken() },
    // Polling first so the connection also works where WebSocket upgrades are blocked;
    // Socket.IO transparently upgrades to WebSocket when it can.
    transports: ['polling', 'websocket'],
    withCredentials: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 700,
    reconnectionDelayMax: 8000,
    timeout: 15000,
  }) as RocksCordSocket;

  socket.on('connect', () => store.setConnected(true));

  socket.on('disconnect', (reason) => {
    useAppStore.getState().setConnected(false);
    if (reason === 'io server disconnect') {
      // The server closed us deliberately; reconnecting requires a fresh handshake.
      void reconnectWithFreshToken();
    }
  });

  socket.io.on('reconnect_attempt', () => {
    void reconnectWithFreshToken();
  });

  socket.on('connect_error', (error) => {
    if (error.message === 'UNAUTHORIZED') void reconnectWithFreshToken();
  });

  registerHandlers(socket);
  return socket;
}

/** Mint a new access token and hand it to the socket before it retries. */
async function reconnectWithFreshToken(): Promise<void> {
  const ok = await refreshAccessToken();
  if (!socket) return;
  if (ok) {
    socket.auth = { token: getAccessToken() };
  }
}

export function disconnectSocket(): void {
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
  useAppStore.getState().setConnected(false);
}

function registerHandlers(s: RocksCordSocket): void {
  const store = () => useAppStore.getState();

  s.on('ready', (payload) => store().applyReady(payload));

  /* Messages ------------------------------------------------------------ */

  s.on('message:create', (message) => store().addMessage(message));
  s.on('message:update', ({ message }) => store().updateMessage(message));
  s.on('message:delete', ({ channelId, messageId }) =>
    store().removeMessage(channelId, messageId),
  );
  s.on('message:reaction:add', ({ channelId, messageId, emoji, userId }) =>
    store().applyReaction(channelId, messageId, emoji, userId, true),
  );
  s.on('message:reaction:remove', ({ channelId, messageId, emoji, userId }) =>
    store().applyReaction(channelId, messageId, emoji, userId, false),
  );

  /* Typing & presence --------------------------------------------------- */

  s.on('typing:start', ({ channelId, userId, username }) => {
    if (userId === store().user?.id) return;
    store().noteTyping(channelId, userId, username);
  });

  s.on('presence:update', ({ userId, status, customStatus }) =>
    store().setPresence(userId, status, customStatus),
  );

  /* Servers, channels, roles, members ------------------------------------ */

  s.on('server:create', (server) => store().upsertServer(server));
  s.on('server:update', (server) => store().upsertServer(server));
  s.on('server:delete', ({ serverId }) => store().removeServer(serverId));

  s.on('channel:create', (channel) => store().upsertChannel(channel));
  s.on('channel:update', (channel) => store().upsertChannel(channel));
  s.on('channel:delete', ({ serverId, channelId }) =>
    store().removeChannel(serverId, channelId),
  );

  s.on('member:join', (member) => store().upsertMember(member));
  s.on('member:update', (member) => store().upsertMember(member));
  s.on('member:leave', ({ serverId, userId }) => store().removeMember(serverId, userId));

  s.on('role:create', (role) => store().upsertRole(role));
  s.on('role:update', (role) => store().upsertRole(role));
  s.on('role:delete', ({ serverId, roleId }) => store().removeRole(serverId, roleId));

  /* Social --------------------------------------------------------------- */

  s.on('dm:create', (channel) => store().upsertDMChannel(channel));
  s.on('friend:request', (friendship) => store().upsertFriendship(friendship));
  s.on('friend:update', (friendship) => store().upsertFriendship(friendship));
  s.on('friend:remove', ({ userId }) => store().removeFriendOf(userId));

  /* Voice ---------------------------------------------------------------- */

  s.on('voice:join', (participant) => store().upsertVoiceParticipant(participant));
  s.on('voice:update', (participant) => store().upsertVoiceParticipant(participant));
  s.on('voice:leave', ({ channelId, userId }) => {
    store().removeVoiceParticipant(channelId, userId);
    handleVoicePeerLeft(userId);
  });
  s.on('voice:signal', (payload) => void handleVoiceSignal(payload));

  /* Notifications --------------------------------------------------------- */

  s.on('notification', (notification) => {
    store().pushNotification(notification);
    void showDesktopNotification(notification.title, notification.body);
  });

  s.on('gateway:error', ({ code, message }) => {
    console.warn(`[gateway] ${code}: ${message}`);
  });
}

/* -------------------------------------------------------------------------- */
/* Emit helpers                                                                */
/* -------------------------------------------------------------------------- */

export function subscribeToChannel(channelId: string): void {
  socket?.emit('channel:subscribe', { channelId });
}

export function unsubscribeFromChannel(channelId: string): void {
  socket?.emit('channel:unsubscribe', { channelId });
}

/**
 * Announce typing, throttled client-side.
 *
 * The server throttles too, but doing it here as well means a fast typist does not send
 * one message per keystroke over the wire in the first place.
 */
const lastTypingSent = new Map<string, number>();
const TYPING_INTERVAL_MS = 3000;

export function sendTyping(channelId: string): void {
  const now = Date.now();
  if (now - (lastTypingSent.get(channelId) ?? 0) < TYPING_INTERVAL_MS) return;
  lastTypingSent.set(channelId, now);
  socket?.emit('typing:start', { channelId });
}

/*
 * The last status the *user* asked for, as opposed to one applied on their behalf.
 *
 * Auto-idle needs this to avoid two mistakes that would each be worse than not having the
 * feature: idling someone out of "do not disturb", and restoring them to "online" when
 * they had deliberately chosen to appear idle or invisible. `null` means the user has not
 * chosen anything this session, so the value from the server stands.
 */
let chosenStatus: UserStatus | null = null;

export function getChosenStatus(): UserStatus | null {
  return chosenStatus;
}

/** Set the status because the user asked for it. */
export function setPresenceStatus(status: UserStatus, customStatus?: string | null): void {
  chosenStatus = status;
  socket?.emit('presence:set', { status, customStatus });
}

/**
 * Set the status on the user's behalf, without disturbing what they chose.
 *
 * Kept separate from `setPresenceStatus` so that going idle at the keyboard cannot be
 * mistaken later for a deliberate choice to appear idle.
 */
export function setAutoPresenceStatus(status: UserStatus): void {
  socket?.emit('presence:set', { status });
}

export function ackRead(channelId: string, messageId: string): void {
  socket?.emit('read:ack', { channelId, messageId });
}

export function emitVoiceJoin(channelId: string): void {
  socket?.emit('voice:join', { channelId });
}

export function emitVoiceLeave(): void {
  socket?.emit('voice:leave');
}

export function emitVoiceState(patch: {
  selfMute?: boolean;
  selfDeaf?: boolean;
  streaming?: boolean;
}): void {
  socket?.emit('voice:state', patch);
}

export function emitVoiceSignal(peerId: string, channelId: string, data: unknown): void {
  socket?.emit('voice:signal', { peerId, channelId, data });
}

/* -------------------------------------------------------------------------- */
/* Desktop notifications                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Show an OS notification when the window is not focused.
 * Permission is requested lazily on the first notification rather than on load, because
 * an unprompted permission dialog on page load is the fastest way to get it denied.
 */
async function showDesktopNotification(title: string, body: string): Promise<void> {
  if (typeof Notification === 'undefined') return;
  if (document.hasFocus()) return;

  if (Notification.permission === 'default') {
    try {
      await Notification.requestPermission();
    } catch {
      return;
    }
  }
  if (Notification.permission !== 'granted') return;

  try {
    new Notification(title, { body, icon: '/favicon.svg', silent: false });
  } catch {
    // Some browsers require a service worker for notifications; failing is acceptable.
  }
}
