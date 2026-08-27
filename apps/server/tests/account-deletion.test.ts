/**
 * Account deletion.
 *
 * The property under test is not "the account goes away" — it is **"deleting your account
 * does not delete anyone else's data"**. Both foreign keys that matter cascade:
 * `messages.author_id` and `servers.owner_id`. A literal DELETE would therefore erase
 * every message the person ever sent, orphaning every reply to them, and destroy any
 * server they owned along with everyone else's history inside it.
 *
 * So the row is tombstoned instead, and most of what follows checks the blast radius
 * rather than the deletion.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createServer,
  createTestApp,
  joinServer,
  registerUser,
  sendMessage,
  type TestApp,
  type TestUser,
} from './helpers.js';
import { messages, servers, users } from '../src/db/schema.js';

describe('deleting an account', () => {
  let test: TestApp;
  let alice: TestUser;

  beforeEach(async () => {
    test = await createTestApp();
    alice = await registerUser(test);
  });

  afterEach(async () => {
    await test.close();
  });

  const remove = (user: TestUser, password: string) =>
    test.app.inject({
      method: 'DELETE',
      url: '/api/users/@me',
      headers: user.auth,
      payload: { password },
    });

  it('requires the account password, not just a session', async () => {
    const response = await remove(alice, 'not the password');

    expect(response.statusCode).toBe(401);
    const [row] = await test.db.select().from(users).where(eq(users.id, alice.id));
    expect(row!.deletedAt).toBeNull();
  });

  it('scrubs every identifying field but keeps the row', async () => {
    const response = await remove(alice, alice.password);
    expect(response.statusCode).toBe(200);

    const [row] = await test.db.select().from(users).where(eq(users.id, alice.id));

    // The row survives, because messages point at it.
    expect(row).toBeDefined();
    expect(row!.deletedAt).not.toBeNull();

    expect(row!.email).not.toBe(alice.email);
    expect(row!.email).toMatch(/@invalid$/);
    expect(row!.username).not.toBe(alice.username);
    expect(row!.displayName).toBe('Deleted User');
    expect(row!.avatarUrl).toBeNull();
    expect(row!.bio).toBeNull();
  });

  it('destroys the credential, so the account cannot be signed into afterwards', async () => {
    await remove(alice, alice.password);

    const response = await test.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: alice.email, password: alice.password },
    });

    expect(response.statusCode).toBe(401);
  });

  it('revokes existing sessions rather than leaving them live', async () => {
    await remove(alice, alice.password);

    const response = await test.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: alice.auth,
    });

    expect(response.statusCode).toBe(401);
  });

  /* ---------------------------------------------------------------------- */
  /* The blast radius                                                        */
  /* ---------------------------------------------------------------------- */

  it("leaves other people's messages and the shared server untouched", async () => {
    const bob = await registerUser(test);
    const { serverId, generalChannelId } = await createServer(test, bob, 'Bob Server');
    await joinServer(test, bob, serverId, alice);

    await sendMessage(test, alice, generalChannelId, 'from alice');
    await sendMessage(test, bob, generalChannelId, 'from bob');

    await remove(alice, alice.password);

    const [server] = await test.db.select().from(servers).where(eq(servers.id, serverId));
    expect(server).toBeDefined();

    const remaining = await test.db.select().from(messages);
    // Both messages, including the deleted user's: removing it would orphan any reply.
    expect(remaining).toHaveLength(2);
  });

  it("keeps the deleted user's messages readable, attributed to a tombstone", async () => {
    const bob = await registerUser(test);
    const { serverId, generalChannelId } = await createServer(test, bob, 'Bob Server');
    await joinServer(test, bob, serverId, alice);
    await sendMessage(test, alice, generalChannelId, 'still here after deletion');

    await remove(alice, alice.password);

    const response = await test.app.inject({
      method: 'GET',
      url: `/api/channels/${generalChannelId}/messages`,
      headers: bob.auth,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const message = body.messages.find(
      (m: { content: string }) => m.content === 'still here after deletion',
    );
    expect(message).toBeDefined();
    expect(message.author.displayName).toBe('Deleted User');
  });

  it('refuses while the account owns a server other people are in', async () => {
    const bob = await registerUser(test);
    const { serverId } = await createServer(test, alice, 'Alice HQ');
    await joinServer(test, alice, serverId, bob);

    const response = await remove(alice, alice.password);

    /*
     * The important half: refusing is what protects Bob. Deleting the server to satisfy
     * Alice's request would take his history with it.
     */
    expect(response.statusCode).toBe(409);
    expect(response.json().error.details.servers).toContain('Alice HQ');

    const [row] = await test.db.select().from(users).where(eq(users.id, alice.id));
    expect(row!.deletedAt).toBeNull();

    const [server] = await test.db.select().from(servers).where(eq(servers.id, serverId));
    expect(server).toBeDefined();
  });

  it('removes a server the account owns alone, since nobody else can lose it', async () => {
    const { serverId } = await createServer(test, alice, 'Solo Server');

    const response = await remove(alice, alice.password);
    expect(response.statusCode).toBe(200);

    const [server] = await test.db.select().from(servers).where(eq(servers.id, serverId));
    expect(server).toBeUndefined();
  });

  /* ---------------------------------------------------------------------- */
  /* Discovery                                                               */
  /* ---------------------------------------------------------------------- */

  it('is no longer findable by username search', async () => {
    const bob = await registerUser(test);
    const username = alice.username;

    await remove(alice, alice.password);

    const response = await test.app.inject({
      method: 'GET',
      url: `/api/search/users?q=${encodeURIComponent(username)}`,
      headers: bob.auth,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().users).toHaveLength(0);
  });

  it('can no longer be sent a friend request', async () => {
    const bob = await registerUser(test);
    const handle = `${alice.username}#${alice.discriminator}`;

    await remove(alice, alice.password);

    const response = await test.app.inject({
      method: 'POST',
      url: '/api/friends/requests',
      headers: bob.auth,
      payload: { username: handle },
    });

    expect(response.statusCode).toBe(404);
  });

  it('cannot be deleted twice', async () => {
    await remove(alice, alice.password);
    const second = await remove(alice, alice.password);
    expect(second.statusCode).toBe(401);
  });
});
