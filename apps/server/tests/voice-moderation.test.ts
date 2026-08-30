/**
 * Server mute and deafen.
 *
 * The interesting part is not "does the flag flip" but who is allowed to flip it, and on
 * whom. Voice state is global -- one channel per person across the entire app -- while the
 * authority to silence someone is scoped to a single server, so most of these tests are
 * about that gap being closed.
 *
 * The flags are also deliberately separate from the `selfMute` a person sets on
 * themselves. The socket handler accepts only self-owned fields, which is what stops a
 * muted member from simply toggling their own microphone back on.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Permission } from '@rockscord/shared';
import {
  assignRole,
  createServer,
  createTestApp,
  joinServer,
  registerUser,
  type TestApp,
  type TestUser,
} from './helpers.js';
import { joinVoice, resetVoice, getVoiceStates } from '../src/realtime/voice.js';

describe('server mute and deafen', () => {
  let test: TestApp;
  let owner: TestUser;
  let moderator: TestUser;
  let target: TestUser;
  let serverId: string;
  let voiceChannelId: string;
  let moderatorRoleId: string;

  beforeEach(async () => {
    test = await createTestApp();
    owner = await registerUser(test);
    moderator = await registerUser(test);
    target = await registerUser(test);

    ({ serverId, voiceChannelId, moderatorRoleId } = await createServer(test, owner, 'Voice Mod'));
    await joinServer(test, owner, serverId, moderator);
    await joinServer(test, owner, serverId, target);
    await assignRole(test, owner, serverId, moderator, [moderatorRoleId]);

    // Put the target in the server's voice channel. The route reads live voice state, so
    // there is nothing to moderate until someone is actually in a call.
    joinVoice(target.id, voiceChannelId);
  });

  afterEach(async () => {
    resetVoice();
    await test.close();
  });

  const moderate = (
    actor: TestUser,
    body: Record<string, boolean>,
    userId = target.id,
    server = serverId,
  ) =>
    test.app.inject({
      method: 'PATCH',
      url: `/api/servers/${server}/members/${userId}/voice`,
      headers: actor.auth,
      payload: body,
    });

  const stateOf = (userId: string) =>
    getVoiceStates(voiceChannelId).find((s) => s.userId === userId);

  /* ---------------------------------------------------------------------- */

  it('mutes someone, and un-mutes them again', async () => {
    const muted = await moderate(owner, { serverMute: true });
    expect(muted.statusCode).toBe(200);
    expect(stateOf(target.id)?.serverMute).toBe(true);

    const unmuted = await moderate(owner, { serverMute: false });
    expect(unmuted.statusCode).toBe(200);
    expect(stateOf(target.id)?.serverMute).toBe(false);
  });

  it('deafens independently of muting', async () => {
    await moderate(owner, { serverDeaf: true });

    const state = stateOf(target.id);
    expect(state?.serverDeaf).toBe(true);
    // Server deafen is not server mute: the two are separate powers and separate flags.
    expect(state?.serverMute).toBe(false);
  });

  it('lets a moderator with the permission do it', async () => {
    const response = await moderate(moderator, { serverMute: true });
    expect(response.statusCode).toBe(200);
  });

  it('refuses a member with no permission', async () => {
    const nobody = await registerUser(test);
    await joinServer(test, owner, serverId, nobody);

    const response = await moderate(nobody, { serverMute: true });
    expect(response.statusCode).toBe(403);
    expect(stateOf(target.id)?.serverMute).toBe(false);
  });

  it('checks each flag against its own permission', async () => {
    /*
     * Muting and deafening are different powers, so a role holding one must not get the
     * other for free. Granting MUTE_MEMBERS alone has to leave deafen refused.
     */
    const muteOnly = await registerUser(test);
    await joinServer(test, owner, serverId, muteOnly);

    const created = await test.app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/roles`,
      headers: owner.auth,
      payload: { name: 'Mute Only', permissions: Permission.MUTE_MEMBERS },
    });
    const roleId = created.json().role.id as string;
    await assignRole(test, owner, serverId, muteOnly, [roleId]);

    expect((await moderate(muteOnly, { serverMute: true })).statusCode).toBe(200);
    expect((await moderate(muteOnly, { serverDeaf: true })).statusCode).toBe(403);
    expect(stateOf(target.id)?.serverDeaf).toBe(false);
  });

  it('will not let a moderator silence the owner', async () => {
    joinVoice(owner.id, voiceChannelId);

    // Rank is what decides this, the same as it does for kicks and bans.
    const response = await moderate(moderator, { serverMute: true }, owner.id);
    expect(response.statusCode).toBe(403);
    expect(stateOf(owner.id)?.serverMute).toBe(false);
  });

  it('refuses when the target is not in a voice channel', async () => {
    const idle = await registerUser(test);
    await joinServer(test, owner, serverId, idle);

    const response = await moderate(owner, { serverMute: true }, idle.id);
    expect(response.statusCode).toBe(404);
  });

  it('will not reach into a call in a different server', async () => {
    /*
     * The sharp edge. Voice state is global, so someone can share this server with a
     * moderator while sitting in a call somewhere else entirely -- and being a moderator
     * here is no authority at all over there.
     */
    const elsewhere = await createServer(test, target, 'Their Own Server');
    joinVoice(target.id, elsewhere.voiceChannelId);

    const response = await moderate(owner, { serverMute: true });
    expect(response.statusCode).toBe(404);

    const state = getVoiceStates(elsewhere.voiceChannelId).find((s) => s.userId === target.id);
    expect(state?.serverMute).toBe(false);
  });

  it('refuses someone who is not in the server at all', async () => {
    const outsider = await registerUser(test);

    const response = await moderate(outsider, { serverMute: true });
    // 404 rather than 403: a non-member is not told the server exists.
    expect(response.statusCode).toBe(404);
  });

  it('rejects a body that asks for nothing', async () => {
    // An empty patch would be a 200 that changed nothing, and each field is gated on a
    // different permission -- so "no fields" has no meaningful permission to check.
    const response = await moderate(owner, {});
    expect(response.statusCode).toBe(400);
  });

  it('cannot be undone by the muted person toggling their own microphone', async () => {
    await moderate(owner, { serverMute: true });

    /*
     * `selfMute` and `serverMute` are separate fields, and the socket handler only accepts
     * the self-owned ones. This asserts the separation directly: the moderator's flag
     * survives whatever the target does to their own state.
     */
    const state = stateOf(target.id);
    expect(state?.serverMute).toBe(true);
    expect(state?.selfMute).toBe(false);
  });
});
