/**
 * Permission and role tests.
 *
 * The point of this file is privilege *escalation*: not just "can a member post", but
 * "can a moderator promote themselves to admin", "can a member read a private channel",
 * "can someone grant a permission they do not hold". Those are the cases that turn a
 * role system from decoration into access control.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_PERMISSIONS, Permission } from '@rockscord/shared';
import {
  assignRole,
  createServer,
  createTestApp,
  joinServer,
  registerUser,
  sendMessage,
  type TestApp,
  type TestUser,
} from './helpers.js';

let test: TestApp;
let owner: TestUser;
let moderator: TestUser;
let member: TestUser;
let outsider: TestUser;
let ids: Awaited<ReturnType<typeof createServer>>;

beforeAll(async () => {
  test = await createTestApp();

  owner = await registerUser(test, { username: 'olive' });
  moderator = await registerUser(test, { username: 'mira' });
  member = await registerUser(test, { username: 'milo' });
  outsider = await registerUser(test, { username: 'otto' });

  ids = await createServer(test, owner, 'Permission Lab');

  await joinServer(test, owner, ids.serverId, moderator);
  await joinServer(test, owner, ids.serverId, member);

  await assignRole(test, owner, ids.serverId, moderator, [ids.moderatorRoleId]);
});

afterAll(async () => {
  await test.close();
});

describe('membership boundaries', () => {
  it('hides a server entirely from non-members', async () => {
    const response = await test.app.inject({
      method: 'GET',
      url: `/api/servers/${ids.serverId}`,
      headers: outsider.auth,
    });

    // 404, not 403: a non-member should not be able to confirm the server exists.
    expect(response.statusCode).toBe(404);
  });

  it('stops a non-member from posting', async () => {
    const result = await sendMessage(test, outsider, ids.generalChannelId, 'let me in');
    expect(result.status).toBe(404);
  });

  it('lets a member post', async () => {
    const result = await sendMessage(test, member, ids.generalChannelId, 'hello');
    expect(result.status).toBe(201);
  });
});

describe('message moderation', () => {
  it('lets an author delete their own message', async () => {
    const sent = await sendMessage(test, member, ids.generalChannelId, 'my own message');

    const response = await test.app.inject({
      method: 'DELETE',
      url: `/api/channels/${ids.generalChannelId}/messages/${sent.body.message.id}`,
      headers: member.auth,
    });

    expect(response.statusCode).toBe(200);
  });

  it("stops a plain member deleting someone else's message", async () => {
    const sent = await sendMessage(test, owner, ids.generalChannelId, 'owner message');

    const response = await test.app.inject({
      method: 'DELETE',
      url: `/api/channels/${ids.generalChannelId}/messages/${sent.body.message.id}`,
      headers: member.auth,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('MISSING_PERMISSIONS');
  });

  it('lets a moderator delete it (MANAGE_MESSAGES)', async () => {
    const sent = await sendMessage(test, member, ids.generalChannelId, 'to be moderated');

    const response = await test.app.inject({
      method: 'DELETE',
      url: `/api/channels/${ids.generalChannelId}/messages/${sent.body.message.id}`,
      headers: moderator.auth,
    });

    expect(response.statusCode).toBe(200);
  });

  it("never lets anyone edit another person's message, not even the owner", async () => {
    const sent = await sendMessage(test, member, ids.generalChannelId, 'my words');

    const response = await test.app.inject({
      method: 'PATCH',
      url: `/api/channels/${ids.generalChannelId}/messages/${sent.body.message.id}`,
      headers: owner.auth,
      payload: { content: 'words the owner put in my mouth' },
    });

    // Deleting someone's message is moderation. Rewriting it is impersonation.
    expect(response.statusCode).toBe(403);
  });
});

describe('privilege escalation', () => {
  it('stops a moderator creating roles at all (no MANAGE_ROLES)', async () => {
    const response = await test.app.inject({
      method: 'POST',
      url: `/api/servers/${ids.serverId}/roles`,
      headers: moderator.auth,
      payload: { name: 'sneaky', permissions: ADMIN_PERMISSIONS },
    });

    // The Moderator preset intentionally excludes MANAGE_ROLES, so this is stopped by
    // the permission check before the escalation check is even reached.
    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toMatch(/manage roles/i);
  });

  it('stops someone with MANAGE_ROLES granting a permission they lack', async () => {
    // The Admin preset has MANAGE_ROLES but deliberately not ADMINISTRATOR, so this
    // user is allowed to create roles yet must not be able to mint an administrator.
    const admin = await registerUser(test, { username: 'ada' });
    await joinServer(test, owner, ids.serverId, admin);
    await assignRole(test, owner, ids.serverId, admin, [ids.adminRoleId]);

    const allowed = await test.app.inject({
      method: 'POST',
      url: `/api/servers/${ids.serverId}/roles`,
      headers: admin.auth,
      payload: { name: 'ordinary role', permissions: Permission.SEND_MESSAGES },
    });
    expect(allowed.statusCode).toBe(201);

    const escalation = await test.app.inject({
      method: 'POST',
      url: `/api/servers/${ids.serverId}/roles`,
      headers: admin.auth,
      payload: { name: 'god mode', permissions: Permission.ADMINISTRATOR },
    });

    expect(escalation.statusCode).toBe(403);
    expect(escalation.json().error.message).toMatch(/do not have/i);
  });

  it('stops a moderator editing a role above their own', async () => {
    const response = await test.app.inject({
      method: 'PATCH',
      url: `/api/servers/${ids.serverId}/roles/${ids.adminRoleId}`,
      headers: moderator.auth,
      payload: { name: 'no longer admin' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('stops a moderator assigning the admin role to anyone', async () => {
    const response = await test.app.inject({
      method: 'PATCH',
      url: `/api/servers/${ids.serverId}/members/${member.id}`,
      headers: moderator.auth,
      payload: { roleIds: [ids.adminRoleId] },
    });

    expect(response.statusCode).toBe(403);
  });

  it('stops a plain member creating roles at all', async () => {
    const response = await test.app.inject({
      method: 'POST',
      url: `/api/servers/${ids.serverId}/roles`,
      headers: member.auth,
      payload: { name: 'member role' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('lets the owner do all of it', async () => {
    const response = await test.app.inject({
      method: 'POST',
      url: `/api/servers/${ids.serverId}/roles`,
      headers: owner.auth,
      payload: { name: 'owner made this', permissions: ADMIN_PERMISSIONS },
    });

    expect(response.statusCode).toBe(201);
  });

  it('refuses to delete the @everyone role', async () => {
    const response = await test.app.inject({
      method: 'DELETE',
      url: `/api/servers/${ids.serverId}/roles/${ids.everyoneRoleId}`,
      headers: owner.auth,
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('role hierarchy', () => {
  it('stops a moderator kicking someone with an equal or higher role', async () => {
    const secondModerator = await registerUser(test, { username: 'marcus' });
    await joinServer(test, owner, ids.serverId, secondModerator);
    await assignRole(test, owner, ids.serverId, secondModerator, [ids.moderatorRoleId]);

    const response = await test.app.inject({
      method: 'DELETE',
      url: `/api/servers/${ids.serverId}/members/${secondModerator.id}`,
      headers: moderator.auth,
    });

    expect(response.statusCode).toBe(403);
  });

  it('stops anyone kicking the server owner', async () => {
    const response = await test.app.inject({
      method: 'DELETE',
      url: `/api/servers/${ids.serverId}/members/${owner.id}`,
      headers: moderator.auth,
    });

    expect(response.statusCode).toBe(403);
  });

  it('lets a moderator kick a plain member', async () => {
    const victim = await registerUser(test, { username: 'kickme' });
    await joinServer(test, owner, ids.serverId, victim);

    const response = await test.app.inject({
      method: 'DELETE',
      url: `/api/servers/${ids.serverId}/members/${victim.id}`,
      headers: moderator.auth,
    });

    expect(response.statusCode).toBe(200);

    // And they really are out.
    const afterKick = await sendMessage(test, victim, ids.generalChannelId, 'still here?');
    expect(afterKick.status).toBe(404);
  });
});

describe('channel permission overwrites', () => {
  it('hides a channel from @everyone when VIEW_CHANNEL is denied', async () => {
    const created = await test.app.inject({
      method: 'POST',
      url: `/api/channels/server/${ids.serverId}`,
      headers: owner.auth,
      payload: { name: 'staff-only', type: 'text' },
    });
    const privateChannelId = created.json().channel.id as string;

    // Deny VIEW_CHANNEL to @everyone.
    const overwrite = await test.app.inject({
      method: 'PUT',
      url: `/api/channels/${privateChannelId}/permissions`,
      headers: owner.auth,
      payload: {
        targetType: 'role',
        targetId: ids.everyoneRoleId,
        allow: 0,
        deny: Permission.VIEW_CHANNEL,
      },
    });
    expect(overwrite.statusCode).toBe(200);

    // The member can no longer see it, or even confirm it exists.
    const read = await test.app.inject({
      method: 'GET',
      url: `/api/channels/${privateChannelId}`,
      headers: member.auth,
    });
    expect(read.statusCode).toBe(404);

    // It is absent from their channel list.
    const list = await test.app.inject({
      method: 'GET',
      url: `/api/channels/server/${ids.serverId}`,
      headers: member.auth,
    });
    const visible = (list.json().channels as { id: string }[]).map((c) => c.id);
    expect(visible).not.toContain(privateChannelId);

    // But the owner still sees it.
    const ownerList = await test.app.inject({
      method: 'GET',
      url: `/api/channels/server/${ids.serverId}`,
      headers: owner.auth,
    });
    const ownerVisible = (ownerList.json().channels as { id: string }[]).map((c) => c.id);
    expect(ownerVisible).toContain(privateChannelId);
  });

  it('restores access when a role overwrite allows it back', async () => {
    const created = await test.app.inject({
      method: 'POST',
      url: `/api/channels/server/${ids.serverId}`,
      headers: owner.auth,
      payload: { name: 'mods-only', type: 'text' },
    });
    const channelId = created.json().channel.id as string;

    await test.app.inject({
      method: 'PUT',
      url: `/api/channels/${channelId}/permissions`,
      headers: owner.auth,
      payload: {
        targetType: 'role',
        targetId: ids.everyoneRoleId,
        allow: 0,
        deny: Permission.VIEW_CHANNEL,
      },
    });

    await test.app.inject({
      method: 'PUT',
      url: `/api/channels/${channelId}/permissions`,
      headers: owner.auth,
      payload: {
        targetType: 'role',
        targetId: ids.moderatorRoleId,
        allow: Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES,
        deny: 0,
      },
    });

    // The moderator's role overwrite beats the @everyone denial.
    const modRead = await test.app.inject({
      method: 'GET',
      url: `/api/channels/${channelId}`,
      headers: moderator.auth,
    });
    expect(modRead.statusCode).toBe(200);

    // The plain member is still locked out.
    const memberRead = await test.app.inject({
      method: 'GET',
      url: `/api/channels/${channelId}`,
      headers: member.auth,
    });
    expect(memberRead.statusCode).toBe(404);
  });

  it('stops a moderator granting themselves a permission they lack via an overwrite', async () => {
    const response = await test.app.inject({
      method: 'PUT',
      url: `/api/channels/${ids.generalChannelId}/permissions`,
      headers: moderator.auth,
      payload: {
        targetType: 'role',
        targetId: ids.moderatorRoleId,
        allow: Permission.ADMINISTRATOR,
        deny: 0,
      },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('server lifecycle', () => {
  it('lets only the owner delete the server', async () => {
    const solo = await registerUser(test, { username: 'solo' });
    const soloIds = await createServer(test, solo, 'Solo Server');

    const helper = await registerUser(test, { username: 'helper' });
    await joinServer(test, solo, soloIds.serverId, helper);
    await assignRole(test, solo, soloIds.serverId, helper, [soloIds.adminRoleId]);

    // Even an Admin cannot delete the server.
    const adminAttempt = await test.app.inject({
      method: 'DELETE',
      url: `/api/servers/${soloIds.serverId}`,
      headers: helper.auth,
    });
    expect(adminAttempt.statusCode).toBe(403);

    const ownerAttempt = await test.app.inject({
      method: 'DELETE',
      url: `/api/servers/${soloIds.serverId}`,
      headers: solo.auth,
    });
    expect(ownerAttempt.statusCode).toBe(200);
  });

  it('refuses to let the owner leave without transferring', async () => {
    const response = await test.app.inject({
      method: 'POST',
      url: `/api/servers/${ids.serverId}/leave`,
      headers: owner.auth,
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses to delete the last text channel', async () => {
    const solo = await registerUser(test, { username: 'lastchannel' });
    const soloIds = await createServer(test, solo, 'One Channel');

    const response = await test.app.inject({
      method: 'DELETE',
      url: `/api/channels/${soloIds.generalChannelId}`,
      headers: solo.auth,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/at least one text channel/i);
  });
});

describe('bans', () => {
  it('removes the member and blocks rejoining', async () => {
    const banned = await registerUser(test, { username: 'banned' });
    await joinServer(test, owner, ids.serverId, banned);

    const ban = await test.app.inject({
      method: 'POST',
      url: `/api/servers/${ids.serverId}/bans/${banned.id}`,
      headers: owner.auth,
      payload: { reason: 'testing' },
    });
    expect(ban.statusCode).toBe(200);

    // A fresh invite must not let them back in.
    const invite = await test.app.inject({
      method: 'POST',
      url: `/api/invites/server/${ids.serverId}`,
      headers: owner.auth,
      payload: {},
    });
    const code = invite.json().invite.code as string;

    const rejoin = await test.app.inject({
      method: 'POST',
      url: `/api/invites/${code}`,
      headers: banned.auth,
    });

    expect(rejoin.statusCode).toBe(403);
    expect(rejoin.json().error.code).toBe('BANNED');
  });
});
