/**
 * Messaging tests: sending, editing, deleting, replies, reactions, mentions,
 * pagination, DMs, and search.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIMITS, userMention } from '@rockscord/shared';
import {
  createServer,
  createTestApp,
  joinServer,
  registerUser,
  sendMessage,
  type TestApp,
  type TestUser,
} from './helpers.js';

let test: TestApp;
let alice: TestUser;
let bob: TestUser;
let ids: Awaited<ReturnType<typeof createServer>>;

beforeAll(async () => {
  test = await createTestApp();
  alice = await registerUser(test, { username: 'alice' });
  bob = await registerUser(test, { username: 'bob' });
  ids = await createServer(test, alice, 'Message Lab');
  await joinServer(test, alice, ids.serverId, bob);
});

afterAll(async () => {
  await test.close();
});

describe('sending', () => {
  it('stores and returns the message', async () => {
    const result = await sendMessage(test, alice, ids.generalChannelId, 'hello world');

    expect(result.status).toBe(201);
    expect(result.body.message.content).toBe('hello world');
    expect(result.body.message.author.username).toBe('alice');
  });

  it('rejects an empty message', async () => {
    const result = await sendMessage(test, alice, ids.generalChannelId, '   ');
    expect(result.status).toBe(400);
  });

  it('rejects a message past the length limit', async () => {
    const result = await sendMessage(
      test,
      alice,
      ids.generalChannelId,
      'x'.repeat(LIMITS.MESSAGE_MAX + 50),
    );
    expect(result.status).toBe(400);
  });

  it('collapses excessive blank lines rather than rejecting them', async () => {
    const result = await sendMessage(test, alice, ids.generalChannelId, 'top\n\n\n\n\n\nbottom');

    expect(result.status).toBe(201);
    expect(result.body.message.content).toBe('top\n\nbottom');
  });

  it('stores HTML as literal text without mangling it', async () => {
    const payload = '<script>alert(1)</script> and 5 < 6';
    const result = await sendMessage(test, alice, ids.generalChannelId, payload);

    // The renderer never uses innerHTML, so content is stored verbatim. Escaping here
    // would corrupt legitimate text like "5 < 6".
    expect(result.status).toBe(201);
    expect(result.body.message.content).toBe(payload);
  });

  it('echoes the nonce so the sender can reconcile its optimistic copy', async () => {
    const result = await sendMessage(test, alice, ids.generalChannelId, 'with nonce', {
      nonce: 'abc123',
    });
    expect(result.body.nonce).toBe('abc123');
  });

  it('refuses text messages in a voice channel', async () => {
    const result = await sendMessage(test, alice, ids.voiceChannelId, 'talking in voice');
    expect(result.status).toBe(400);
  });
});

describe('replies', () => {
  it('attaches a preview of the replied-to message', async () => {
    const original = await sendMessage(test, alice, ids.generalChannelId, 'the original');
    const reply = await sendMessage(test, bob, ids.generalChannelId, 'the reply', {
      replyToId: original.body.message.id,
    });

    expect(reply.status).toBe(201);
    expect(reply.body.message.replyTo.content).toBe('the original');
    expect(reply.body.message.replyTo.author.username).toBe('alice');
  });

  it('refuses to reply to a message in another channel', async () => {
    const other = await test.app.inject({
      method: 'POST',
      url: `/api/channels/server/${ids.serverId}`,
      headers: alice.auth,
      payload: { name: 'elsewhere', type: 'text' },
    });
    const otherChannelId = other.json().channel.id as string;

    const foreign = await sendMessage(test, alice, otherChannelId, 'over here');
    const reply = await sendMessage(test, alice, ids.generalChannelId, 'cross-channel reply', {
      replyToId: foreign.body.message.id,
    });

    // Allowing this would leak content from a channel the reader may not be able to see.
    expect(reply.status).toBe(400);
  });

  it('keeps replies renderable after the original is deleted', async () => {
    const original = await sendMessage(test, alice, ids.generalChannelId, 'will vanish');
    const reply = await sendMessage(test, bob, ids.generalChannelId, 'replying', {
      replyToId: original.body.message.id,
    });

    await test.app.inject({
      method: 'DELETE',
      url: `/api/channels/${ids.generalChannelId}/messages/${original.body.message.id}`,
      headers: alice.auth,
    });

    const history = await test.app.inject({
      method: 'GET',
      url: `/api/channels/${ids.generalChannelId}/messages?limit=50`,
      headers: bob.auth,
    });

    const found = (history.json().messages as { id: string; replyTo: { deleted: boolean } | null }[])
      .find((m) => m.id === reply.body.message.id);

    // Tombstoned, not removed: the reply still renders with a "deleted" placeholder.
    expect(found?.replyTo?.deleted).toBe(true);
  });
});

describe('editing', () => {
  it('marks the message edited', async () => {
    const sent = await sendMessage(test, alice, ids.generalChannelId, 'before');

    const response = await test.app.inject({
      method: 'PATCH',
      url: `/api/channels/${ids.generalChannelId}/messages/${sent.body.message.id}`,
      headers: alice.auth,
      payload: { content: 'after' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().message.content).toBe('after');
    expect(response.json().message.editedAt).toBeTypeOf('number');
  });

  it('refuses to blank a message via edit', async () => {
    const sent = await sendMessage(test, alice, ids.generalChannelId, 'content');

    const response = await test.app.inject({
      method: 'PATCH',
      url: `/api/channels/${ids.generalChannelId}/messages/${sent.body.message.id}`,
      headers: alice.auth,
      payload: { content: '   ' },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('reactions', () => {
  it('adds, counts, and removes a reaction', async () => {
    const sent = await sendMessage(test, alice, ids.generalChannelId, 'react to me');
    const messageId = sent.body.message.id as string;
    const emoji = encodeURIComponent('👍');

    await test.app.inject({
      method: 'PUT',
      url: `/api/channels/${ids.generalChannelId}/messages/${messageId}/reactions/${emoji}`,
      headers: alice.auth,
    });
    await test.app.inject({
      method: 'PUT',
      url: `/api/channels/${ids.generalChannelId}/messages/${messageId}/reactions/${emoji}`,
      headers: bob.auth,
    });

    let history = await test.app.inject({
      method: 'GET',
      url: `/api/channels/${ids.generalChannelId}/messages?limit=50`,
      headers: alice.auth,
    });
    let message = (history.json().messages as { id: string; reactions: { emoji: string; count: number; me: boolean }[] }[])
      .find((m) => m.id === messageId)!;

    expect(message.reactions[0]!.count).toBe(2);
    expect(message.reactions[0]!.me).toBe(true);

    await test.app.inject({
      method: 'DELETE',
      url: `/api/channels/${ids.generalChannelId}/messages/${messageId}/reactions/${emoji}`,
      headers: alice.auth,
    });

    history = await test.app.inject({
      method: 'GET',
      url: `/api/channels/${ids.generalChannelId}/messages?limit=50`,
      headers: alice.auth,
    });
    message = (history.json().messages as { id: string; reactions: { count: number; me: boolean }[] }[])
      .find((m) => m.id === messageId)!;

    expect(message.reactions[0]!.count).toBe(1);
    expect(message.reactions[0]!.me).toBe(false);
  });

  it('does not double-count the same reaction from one person', async () => {
    const sent = await sendMessage(test, alice, ids.generalChannelId, 'once only');
    const messageId = sent.body.message.id as string;
    const emoji = encodeURIComponent('🎉');

    for (let i = 0; i < 3; i += 1) {
      await test.app.inject({
        method: 'PUT',
        url: `/api/channels/${ids.generalChannelId}/messages/${messageId}/reactions/${emoji}`,
        headers: alice.auth,
      });
    }

    const history = await test.app.inject({
      method: 'GET',
      url: `/api/channels/${ids.generalChannelId}/messages?limit=50`,
      headers: alice.auth,
    });
    const message = (history.json().messages as { id: string; reactions: { count: number }[] }[])
      .find((m) => m.id === messageId)!;

    expect(message.reactions[0]!.count).toBe(1);
  });
});

describe('mentions', () => {
  it('records a real mention and creates a notification', async () => {
    const result = await sendMessage(
      test,
      alice,
      ids.generalChannelId,
      `hey ${userMention(bob.id)} look at this`,
    );

    expect(result.status).toBe(201);
    expect(result.body.message.mentionUserIds).toContain(bob.id);

    const notifications = await test.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: bob.auth,
    });
    const list = notifications.json().notifications as { type: string }[];
    expect(list.some((n) => n.type === 'mention')).toBe(true);
  });

  it('ignores a mention token for someone outside the server', async () => {
    const stranger = await registerUser(test, { username: 'stranger' });

    const result = await sendMessage(
      test,
      alice,
      ids.generalChannelId,
      `hello ${userMention(stranger.id)}`,
    );

    // A crafted id must not create a notification for someone who cannot see the server.
    expect(result.body.message.mentionUserIds).not.toContain(stranger.id);
  });

  it('only honours @everyone when the sender has the permission', async () => {
    const fromMember = await sendMessage(test, bob, ids.generalChannelId, 'hey @everyone');
    expect(fromMember.body.message.mentionsEveryone).toBe(false);

    const fromOwner = await sendMessage(test, alice, ids.generalChannelId, 'hey @everyone');
    expect(fromOwner.body.message.mentionsEveryone).toBe(true);
  });
});

describe('pagination', () => {
  it('walks backwards through history without gaps or repeats', async () => {
    const channel = await test.app.inject({
      method: 'POST',
      url: `/api/channels/server/${ids.serverId}`,
      headers: alice.auth,
      payload: { name: 'paging', type: 'text' },
    });
    const channelId = channel.json().channel.id as string;

    const total = 25;
    for (let i = 0; i < total; i += 1) {
      await sendMessage(test, alice, channelId, `message ${i}`);
    }

    const first = await test.app.inject({
      method: 'GET',
      url: `/api/channels/${channelId}/messages?limit=10`,
      headers: alice.auth,
    });
    const firstPage = first.json();

    expect(firstPage.messages).toHaveLength(10);
    expect(firstPage.hasMore).toBe(true);
    // Oldest-first ordering, so the client can append without re-sorting.
    expect(firstPage.messages[0].content).toBe('message 15');
    expect(firstPage.messages[9].content).toBe('message 24');

    const second = await test.app.inject({
      method: 'GET',
      url: `/api/channels/${channelId}/messages?limit=10&before=${firstPage.messages[0].id}`,
      headers: alice.auth,
    });
    const secondPage = second.json();

    expect(secondPage.messages).toHaveLength(10);
    expect(secondPage.messages[9].content).toBe('message 14');

    // No overlap between pages.
    const firstIds = new Set((firstPage.messages as { id: string }[]).map((m) => m.id));
    const overlap = (secondPage.messages as { id: string }[]).filter((m) => firstIds.has(m.id));
    expect(overlap).toHaveLength(0);

    const third = await test.app.inject({
      method: 'GET',
      url: `/api/channels/${channelId}/messages?limit=10&before=${secondPage.messages[0].id}`,
      headers: alice.auth,
    });
    expect(third.json().messages).toHaveLength(5);
    expect(third.json().hasMore).toBe(false);
  });
});

describe('direct messages', () => {
  it('opens a conversation and delivers messages', async () => {
    const opened = await test.app.inject({
      method: 'POST',
      url: '/api/dms',
      headers: alice.auth,
      payload: { userId: bob.id },
    });

    expect(opened.statusCode).toBe(201);
    const channelId = opened.json().channel.id as string;

    const sent = await sendMessage(test, alice, channelId, 'private hello');
    expect(sent.status).toBe(201);

    const bobView = await test.app.inject({
      method: 'GET',
      url: `/api/channels/${channelId}/messages`,
      headers: bob.auth,
    });
    expect(bobView.statusCode).toBe(200);
    expect(bobView.json().messages[0].content).toBe('private hello');
  });

  it('reuses the same channel instead of creating duplicates', async () => {
    const first = await test.app.inject({
      method: 'POST',
      url: '/api/dms',
      headers: alice.auth,
      payload: { userId: bob.id },
    });
    const second = await test.app.inject({
      method: 'POST',
      url: '/api/dms',
      headers: bob.auth,
      payload: { userId: alice.id },
    });

    expect(second.json().channel.id).toBe(first.json().channel.id);
    expect(second.json().created).toBe(false);
  });

  it('keeps a third party out of the conversation', async () => {
    const opened = await test.app.inject({
      method: 'POST',
      url: '/api/dms',
      headers: alice.auth,
      payload: { userId: bob.id },
    });
    const channelId = opened.json().channel.id as string;

    const nosy = await registerUser(test, { username: 'nosy' });
    const attempt = await test.app.inject({
      method: 'GET',
      url: `/api/channels/${channelId}/messages`,
      headers: nosy.auth,
    });

    expect(attempt.statusCode).toBe(404);
  });

  it('refuses a DM to yourself', async () => {
    const response = await test.app.inject({
      method: 'POST',
      url: '/api/dms',
      headers: alice.auth,
      payload: { userId: alice.id },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('search', () => {
  it('finds a message by word and scopes results to visible channels', async () => {
    await sendMessage(test, alice, ids.generalChannelId, 'the pineapple situation is escalating');

    const found = await test.app.inject({
      method: 'GET',
      url: '/api/search/messages?q=pineapple',
      headers: alice.auth,
    });

    expect(found.statusCode).toBe(200);
    const messages = found.json().messages as { content: string }[];
    expect(messages.some((m) => m.content.includes('pineapple'))).toBe(true);

    // A stranger with no shared channels finds nothing.
    const stranger = await registerUser(test, { username: 'quiet' });
    const empty = await test.app.inject({
      method: 'GET',
      url: '/api/search/messages?q=pineapple',
      headers: stranger.auth,
    });
    expect(empty.json().messages).toHaveLength(0);
  });

  it('treats FTS operators in the query as literal text', async () => {
    // A raw MATCH would be a syntax error or an unintended query; escaping makes it a
    // plain phrase search that simply finds nothing.
    const response = await test.app.inject({
      method: 'GET',
      url: `/api/search/messages?q=${encodeURIComponent('pineapple" OR 1=1 --')}`,
      headers: alice.auth,
    });

    expect(response.statusCode).toBe(200);
  });

  it('finds users by username', async () => {
    const response = await test.app.inject({
      method: 'GET',
      url: '/api/search/users?q=bob',
      headers: alice.auth,
    });

    expect(response.statusCode).toBe(200);
    expect((response.json().users as { username: string }[]).some((u) => u.username === 'bob')).toBe(
      true,
    );
  });
});

describe('read state', () => {
  it('reports a channel unread until acknowledged', async () => {
    const channel = await test.app.inject({
      method: 'POST',
      url: `/api/channels/server/${ids.serverId}`,
      headers: alice.auth,
      payload: { name: 'unread-test', type: 'text' },
    });
    const channelId = channel.json().channel.id as string;

    const sent = await sendMessage(test, alice, channelId, 'bob has not seen this');

    let states = await test.app.inject({
      method: 'GET',
      url: '/api/users/@me/read-states',
      headers: bob.auth,
    });
    let state = (states.json().readStates as { channelId: string; unread: boolean }[]).find(
      (s) => s.channelId === channelId,
    );
    expect(state?.unread).toBe(true);

    await test.app.inject({
      method: 'POST',
      url: `/api/channels/${channelId}/ack`,
      headers: bob.auth,
      payload: { messageId: sent.body.message.id },
    });

    states = await test.app.inject({
      method: 'GET',
      url: '/api/users/@me/read-states',
      headers: bob.auth,
    });
    state = (states.json().readStates as { channelId: string; unread: boolean }[]).find(
      (s) => s.channelId === channelId,
    );
    expect(state?.unread).toBe(false);
  });
});
