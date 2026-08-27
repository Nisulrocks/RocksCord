/**
 * Realtime gateway tests.
 *
 * These run against a real listening server with real Socket.IO clients, because the
 * things worth testing here -- handshake auth, room membership, fan-out, presence
 * reference counting -- only exist once there is an actual connection.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import type { Message, ReadyPayload } from '@rockscord/shared';
import {
  createLiveTestApp,
  createServer,
  joinServer,
  registerUser,
  type TestApp,
  type TestUser,
} from './helpers.js';

let test: TestApp;
let alice: TestUser;
let bob: TestUser;
let ids: Awaited<ReturnType<typeof createServer>>;

const sockets: Socket[] = [];

/** Connect a client and resolve once the server has sent its `ready` payload. */
function connect(token: string, label: string): Promise<{ socket: Socket; ready: ReadyPayload }> {
  return new Promise((resolve, reject) => {
    const socket = io(test.url, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      timeout: 8000,
    });
    sockets.push(socket);

    const timer = setTimeout(() => reject(new Error(`${label}: no ready within 10s`)), 10000);

    socket.on('ready', (payload: ReadyPayload) => {
      clearTimeout(timer);
      resolve({ socket, ready: payload });
    });
    socket.on('connect_error', (error) => {
      clearTimeout(timer);
      reject(new Error(`${label}: ${error.message}`));
    });
  });
}

/** Wait for one event, with a timeout that fails the test rather than hanging it. */
function waitFor<T>(socket: Socket, event: string, timeoutMs = 6000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for "${event}"`)),
      timeoutMs,
    );
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** Assert an event does NOT arrive within a window. */
async function expectNoEvent(socket: Socket, event: string, windowMs = 700): Promise<void> {
  let fired = false;
  const handler = () => {
    fired = true;
  };
  socket.on(event, handler);
  await new Promise((resolve) => setTimeout(resolve, windowMs));
  socket.off(event, handler);
  expect(fired, `expected no "${event}" event`).toBe(false);
}

beforeAll(async () => {
  test = await createLiveTestApp();
  alice = await registerUser(test, { username: 'rtalice' });
  bob = await registerUser(test, { username: 'rtbob' });
  ids = await createServer(test, alice, 'Realtime Lab');
  await joinServer(test, alice, ids.serverId, bob);
});

/**
 * Disconnect every socket between tests.
 *
 * Presence is reference counted per user, so a socket left open by an earlier test would
 * keep that user "online" and suppress the very `presence:update` a later test waits for.
 * The short delay gives the server time to process the disconnects.
 */
afterEach(async () => {
  for (const socket of sockets) socket.disconnect();
  sockets.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 250));
});

afterAll(async () => {
  for (const socket of sockets) socket.disconnect();
  await test.close();
});

describe('handshake', () => {
  it('rejects a connection with no token', async () => {
    const error = await new Promise<string>((resolve) => {
      const socket = io(test.url, {
        transports: ['websocket'],
        reconnection: false,
      });
      sockets.push(socket);
      socket.on('connect_error', (err) => resolve(err.message));
    });

    expect(error).toBe('UNAUTHORIZED');
  });

  it('rejects a forged token', async () => {
    const error = await new Promise<string>((resolve) => {
      const socket = io(test.url, {
        auth: { token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.nope' },
        transports: ['websocket'],
        reconnection: false,
      });
      sockets.push(socket);
      socket.on('connect_error', (err) => resolve(err.message));
    });

    expect(error).toBe('UNAUTHORIZED');
  });

  it('sends a ready payload containing the whole initial state', async () => {
    const { ready } = await connect(alice.accessToken, 'alice');

    expect(ready.user.id).toBe(alice.id);
    expect(ready.servers.map((s) => s.id)).toContain(ids.serverId);
    expect(ready.channels.map((c) => c.id)).toContain(ids.generalChannelId);
    expect(ready.roles.length).toBeGreaterThan(0);
  });
});

describe('message delivery', () => {
  it('delivers a message to another user in the same channel', async () => {
    const a = await connect(alice.accessToken, 'alice');
    const b = await connect(bob.accessToken, 'bob');

    a.socket.emit('channel:subscribe', { channelId: ids.generalChannelId });
    b.socket.emit('channel:subscribe', { channelId: ids.generalChannelId });
    await new Promise((resolve) => setTimeout(resolve, 250));

    const received = waitFor<Message>(b.socket, 'message:create');

    const posted = await test.app.inject({
      method: 'POST',
      url: `/api/channels/${ids.generalChannelId}/messages`,
      headers: alice.auth,
      payload: { content: 'realtime hello' },
    });
    expect(posted.statusCode).toBe(201);

    const message = await received;
    expect(message.content).toBe('realtime hello');
    expect(message.authorId).toBe(alice.id);
  });

  it('propagates edits and deletes', async () => {
    const b = await connect(bob.accessToken, 'bob-edits');
    b.socket.emit('channel:subscribe', { channelId: ids.generalChannelId });
    await new Promise((resolve) => setTimeout(resolve, 250));

    const posted = await test.app.inject({
      method: 'POST',
      url: `/api/channels/${ids.generalChannelId}/messages`,
      headers: alice.auth,
      payload: { content: 'original text' },
    });
    const messageId = posted.json().message.id as string;

    const edited = waitFor<{ message: Message }>(b.socket, 'message:update');
    await test.app.inject({
      method: 'PATCH',
      url: `/api/channels/${ids.generalChannelId}/messages/${messageId}`,
      headers: alice.auth,
      payload: { content: 'edited text' },
    });
    expect((await edited).message.content).toBe('edited text');

    const deleted = waitFor<{ messageId: string }>(b.socket, 'message:delete');
    await test.app.inject({
      method: 'DELETE',
      url: `/api/channels/${ids.generalChannelId}/messages/${messageId}`,
      headers: alice.auth,
    });
    expect((await deleted).messageId).toBe(messageId);
  });

  it('does not leak messages from a channel the user cannot view', async () => {
    // A private channel that only the owner can see.
    const created = await test.app.inject({
      method: 'POST',
      url: `/api/channels/server/${ids.serverId}`,
      headers: alice.auth,
      payload: { name: 'secret-room', type: 'text' },
    });
    const privateChannelId = created.json().channel.id as string;

    await test.app.inject({
      method: 'PUT',
      url: `/api/channels/${privateChannelId}/permissions`,
      headers: alice.auth,
      payload: {
        targetType: 'role',
        targetId: ids.everyoneRoleId,
        allow: 0,
        deny: 1, // VIEW_CHANNEL
      },
    });

    const b = await connect(bob.accessToken, 'bob-private');

    // The subscribe attempt must be refused rather than silently joining the room.
    const gatewayError = waitFor<{ code: string }>(b.socket, 'gateway:error', 3000);
    b.socket.emit('channel:subscribe', { channelId: privateChannelId });
    expect((await gatewayError).code).toBe('FORBIDDEN');

    // And no message from that channel reaches them.
    const noMessage = expectNoEvent(b.socket, 'message:create', 900);
    await test.app.inject({
      method: 'POST',
      url: `/api/channels/${privateChannelId}/messages`,
      headers: alice.auth,
      payload: { content: 'for owner eyes only' },
    });
    await noMessage;
  });
});

describe('typing indicators', () => {
  it('reaches other people but never echoes back to the sender', async () => {
    const a = await connect(alice.accessToken, 'alice-typing');
    const b = await connect(bob.accessToken, 'bob-typing');

    a.socket.emit('channel:subscribe', { channelId: ids.generalChannelId });
    b.socket.emit('channel:subscribe', { channelId: ids.generalChannelId });
    await new Promise((resolve) => setTimeout(resolve, 250));

    const seen = waitFor<{ userId: string }>(b.socket, 'typing:start');
    const notEchoed = expectNoEvent(a.socket, 'typing:start', 800);

    a.socket.emit('typing:start', { channelId: ids.generalChannelId });

    expect((await seen).userId).toBe(alice.id);
    await notEchoed;
  });
});

describe('presence', () => {
  it('announces a user coming online', async () => {
    const a = await connect(alice.accessToken, 'alice-presence');
    await new Promise((resolve) => setTimeout(resolve, 200));

    const update = waitFor<{ userId: string; status: string }>(a.socket, 'presence:update');
    await connect(bob.accessToken, 'bob-presence');

    const payload = await update;
    expect(payload.userId).toBe(bob.id);
    expect(payload.status).toBe('online');
  });

  it('keeps a user online while any of their sockets remain', async () => {
    const watcher = await connect(alice.accessToken, 'watcher');
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Bob opens two "tabs".
    const first = await connect(bob.accessToken, 'bob-tab1');
    const second = await connect(bob.accessToken, 'bob-tab2');
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Closing one must NOT report him offline -- presence is reference counted.
    const noOffline = (async () => {
      let wentOffline = false;
      const handler = (payload: { userId: string; status: string }) => {
        if (payload.userId === bob.id && payload.status === 'offline') wentOffline = true;
      };
      watcher.socket.on('presence:update', handler);
      first.socket.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 900));
      watcher.socket.off('presence:update', handler);
      return wentOffline;
    })();

    expect(await noOffline).toBe(false);

    // Closing the last one does.
    const offline = waitFor<{ userId: string; status: string }>(
      watcher.socket,
      'presence:update',
      4000,
    );
    second.socket.disconnect();
    const payload = await offline;
    expect(payload.userId).toBe(bob.id);
    expect(payload.status).toBe('offline');
  });
});

describe('voice signalling', () => {
  it('announces join and leave to the server room', async () => {
    const a = await connect(alice.accessToken, 'alice-voice');
    const b = await connect(bob.accessToken, 'bob-voice');
    await new Promise((resolve) => setTimeout(resolve, 250));

    const joined = waitFor<{ userId: string; channelId: string }>(b.socket, 'voice:join');
    a.socket.emit('voice:join', { channelId: ids.voiceChannelId });

    const participant = await joined;
    expect(participant.userId).toBe(alice.id);
    expect(participant.channelId).toBe(ids.voiceChannelId);

    const left = waitFor<{ userId: string }>(b.socket, 'voice:leave');
    a.socket.emit('voice:leave');
    expect((await left).userId).toBe(alice.id);
  });

  it('refuses to relay a signal to someone not in the same voice channel', async () => {
    const a = await connect(alice.accessToken, 'alice-signal');
    const b = await connect(bob.accessToken, 'bob-signal');
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Alice is in voice; Bob is not. The relay must drop this.
    a.socket.emit('voice:join', { channelId: ids.voiceChannelId });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const noSignal = expectNoEvent(b.socket, 'voice:signal', 900);
    a.socket.emit('voice:signal', {
      peerId: bob.id,
      channelId: ids.voiceChannelId,
      data: { type: 'offer', sdp: {} },
    });
    await noSignal;

    a.socket.emit('voice:leave');
  });
});
