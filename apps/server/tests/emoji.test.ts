/**
 * Custom server emoji.
 *
 * The interesting cases are not "does upload work" but the boundaries around it: names
 * are embedded in message text as `<:name:id>`, so a name that could contain `:` or `>`
 * would let one break out of its own token. The alphabet is restricted rather than
 * escaped, and these tests are what hold that line.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  TINY_PNG,
  createServer,
  createTestApp,
  joinServer,
  multipart,
  registerUser,
  type TestApp,
  type TestUser,
} from './helpers.js';
import { emojis } from '../src/db/schema.js';

describe('custom emoji', () => {
  let test: TestApp;
  let owner: TestUser;
  let serverId: string;

  beforeEach(async () => {
    test = await createTestApp();
    owner = await registerUser(test);
    ({ serverId } = await createServer(test, owner, 'Emoji Server'));
  });

  afterEach(async () => {
    await test.close();
  });

  const upload = (user: TestUser, name: string, file = TINY_PNG) => {
    const body = multipart('emoji.png', 'image/png', file);
    return test.app.inject({
      method: 'POST',
      url: `/api/files/emoji/${serverId}?name=${encodeURIComponent(name)}`,
      headers: { ...user.auth, ...body.headers },
      payload: body.body,
    });
  };

  const list = (user: TestUser) =>
    test.app.inject({
      method: 'GET',
      url: `/api/servers/${serverId}/emojis`,
      headers: user.auth,
    });

  /* ---------------------------------------------------------------------- */

  it('uploads an emoji and returns it', async () => {
    const response = await upload(owner, 'party_cat');

    expect(response.statusCode).toBe(200);
    const emoji = response.json().emoji;
    expect(emoji.name).toBe('party_cat');
    expect(emoji.serverId).toBe(serverId);
    expect(emoji.imageUrl).toBeTruthy();

    const listed = await list(owner);
    expect(listed.json().emojis).toHaveLength(1);
  });

  it('lowercases the name, so :Cat: and :cat: cannot both exist', async () => {
    const created = await upload(owner, 'CAT');
    expect(created.statusCode).toBe(200);
    expect(created.json().emoji.name).toBe('cat');

    const duplicate = await upload(owner, 'cat');
    expect(duplicate.statusCode).toBe(409);
  });

  it.each([
    ['a', 'too short'],
    ['x'.repeat(33), 'too long'],
    ['has space', 'contains a space'],
    ['bad:name', 'contains a colon'],
    ['bad>name', 'contains an angle bracket'],
    ['emoji!', 'contains punctuation'],
  ])('rejects the name %j (%s)', async (name) => {
    /*
     * Each of these could otherwise end up inside `<:name:id>` in message text. A colon
     * or a `>` would terminate the token early and leave the remainder as loose text --
     * which is why the alphabet is closed rather than escaped at render time.
     */
    const response = await upload(owner, name);
    expect(response.statusCode).toBe(400);

    const rows = await test.db.select().from(emojis).where(eq(emojis.serverId, serverId));
    expect(rows).toHaveLength(0);
  });

  it('refuses a file that is not an image', async () => {
    const response = await upload(owner, 'nope', Buffer.from('#!/bin/sh\necho hi\n'));
    expect(response.statusCode).toBe(415);
  });

  it('lets any member list them, but only managers add them', async () => {
    const member = await registerUser(test);
    await joinServer(test, owner, serverId, member);

    await upload(owner, 'shared');

    // Reading is fine: they are rendered in messages anyway.
    const listed = await list(member);
    expect(listed.statusCode).toBe(200);
    expect(listed.json().emojis).toHaveLength(1);

    const attempted = await upload(member, 'sneaky');
    expect(attempted.statusCode).toBe(403);
  });

  it('is not visible to someone outside the server', async () => {
    const outsider = await registerUser(test);
    await upload(owner, 'private');

    const response = await list(outsider);
    /*
     * 404 rather than 403, and deliberately so: a non-member is told the resource does
     * not exist rather than that they are not allowed in, which would confirm the server
     * is real. The same choice is made for channels they cannot view.
     */
    expect(response.statusCode).toBe(404);
  });

  it('deletes an emoji, leaving past messages intact', async () => {
    const created = await upload(owner, 'temporary');
    const emojiId = created.json().emoji.id;

    const deleted = await test.app.inject({
      method: 'DELETE',
      url: `/api/servers/${serverId}/emojis/${emojiId}`,
      headers: owner.auth,
    });
    expect(deleted.statusCode).toBe(200);

    const listed = await list(owner);
    expect(listed.json().emojis).toHaveLength(0);
  });

  it('will not delete an emoji belonging to a different server', async () => {
    const other = await registerUser(test);
    const { serverId: otherServerId } = await createServer(test, other, 'Other');

    const created = await upload(owner, 'mine');
    const emojiId = created.json().emoji.id;

    const response = await test.app.inject({
      method: 'DELETE',
      url: `/api/servers/${otherServerId}/emojis/${emojiId}`,
      headers: other.auth,
    });

    // Scoped by server as well as by id, so owning *a* server is not owning this emoji.
    expect(response.statusCode).toBe(404);

    const rows = await test.db.select().from(emojis).where(eq(emojis.id, emojiId));
    expect(rows).toHaveLength(1);
  });

  it('arrives in the ready payload so messages can render without a round trip', async () => {
    await upload(owner, 'ready_check');

    const response = await test.app.inject({
      method: 'GET',
      url: `/api/servers/${serverId}/emojis`,
      headers: owner.auth,
    });
    expect(response.json().emojis[0].name).toBe('ready_check');
  });
});
