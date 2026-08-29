/**
 * Marking a whole server read.
 *
 * This exists as a server route rather than a loop on the client for one reason: the
 * client does not know the newest message id in channels it has never opened, and those
 * are exactly the ones somebody reaches for this to clear.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createServer,
  createTestApp,
  joinServer,
  registerUser,
  sendMessage,
  type TestApp,
  type TestUser,
} from './helpers.js';

describe('marking a server read', () => {
  let test: TestApp;
  let owner: TestUser;
  let reader: TestUser;
  let serverId: string;
  let generalChannelId: string;

  beforeEach(async () => {
    test = await createTestApp();
    owner = await registerUser(test);
    reader = await registerUser(test);
    ({ serverId, generalChannelId } = await createServer(test, owner, 'Read Server'));
    await joinServer(test, owner, serverId, reader);
  });

  afterEach(async () => {
    await test.close();
  });

  const markRead = (user: TestUser, id = serverId) =>
    test.app.inject({
      method: 'POST',
      url: `/api/users/@me/read-states/server/${id}`,
      headers: user.auth,
    });

  const readStates = async (user: TestUser) => {
    const response = await test.app.inject({
      method: 'GET',
      url: '/api/users/@me/read-states',
      headers: user.auth,
    });
    return response.json().readStates as { channelId: string; unread: boolean }[];
  };

  it('clears unread across every channel at once', async () => {
    await sendMessage(test, owner, generalChannelId, 'first');
    await sendMessage(test, owner, generalChannelId, 'second');

    const before = await readStates(reader);
    expect(before.find((s) => s.channelId === generalChannelId)?.unread).toBe(true);

    const response = await markRead(reader);
    expect(response.statusCode).toBe(200);

    const after = await readStates(reader);
    expect(after.find((s) => s.channelId === generalChannelId)?.unread).toBe(false);
  });

  it('is idempotent, so pressing it twice is harmless', async () => {
    await sendMessage(test, owner, generalChannelId, 'hello');

    await markRead(reader);
    const second = await markRead(reader);

    expect(second.statusCode).toBe(200);
    const after = await readStates(reader);
    expect(after.find((s) => s.channelId === generalChannelId)?.unread).toBe(false);
  });

  it('does not mark anything read in a server the user is not in', async () => {
    const outsider = await registerUser(test);
    await sendMessage(test, owner, generalChannelId, 'private');

    const response = await markRead(outsider);
    /*
     * 404, not 403: a non-member is told the server does not exist rather than that they
     * are excluded from it, matching every other membership-gated route.
     */
    expect(response.statusCode).toBe(404);

    // And the owner's own state is untouched by the attempt.
    const owners = await readStates(owner);
    expect(owners.some((s) => s.channelId === generalChannelId)).toBe(true);
  });

  it('leaves later messages unread, rather than muting the channel forever', async () => {
    await sendMessage(test, owner, generalChannelId, 'before');
    await markRead(reader);

    await sendMessage(test, owner, generalChannelId, 'after');

    const after = await readStates(reader);
    expect(after.find((s) => s.channelId === generalChannelId)?.unread).toBe(true);
  });

  it('succeeds on a server with no messages at all', async () => {
    const response = await markRead(reader);
    expect(response.statusCode).toBe(200);
    expect(response.json().readStates).toEqual([]);
  });
});
