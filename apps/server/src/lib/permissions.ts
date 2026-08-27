/**
 * Server-side permission resolution.
 *
 * The pure bitfield maths lives in `@rockscord/shared` so the client can grey out buttons
 * using the exact same logic. This module is the part that needs the database: it loads
 * the member's roles and the channel's overwrites, feeds them to the shared resolver, and
 * throws the right `ApiError` when a check fails.
 *
 * Client-side checks are a UX affordance only. Every mutating route calls into this
 * module, so hiding a button is never what actually enforces a rule.
 */

import { and, eq, inArray } from 'drizzle-orm';
import {
  ALL_PERMISSIONS,
  Permission,
  hasPermission,
  resolveBasePermissions,
  resolveChannelPermissions,
  type PermissionBits,
  type PermissionOverwrite,
} from '@rockscord/shared';
import type { Database } from '../db/index.js';
import {
  bans,
  channelOverwrites,
  channels,
  dmParticipants,
  memberRoles,
  members,
  roles,
  servers,
} from '../db/schema.js';
import { ApiError } from './errors.js';

export interface MemberContext {
  serverId: string;
  userId: string;
  isOwner: boolean;
  /** Ids of every role held, excluding @everyone. */
  roleIds: string[];
  everyoneRoleId: string;
  /** Server-wide permissions, before channel overwrites. */
  permissions: PermissionBits;
  /** Highest role position held; used for hierarchy checks (can I kick this person?). */
  highestRolePosition: number;
  nickname: string | null;
}

/**
 * Load everything needed to make permission decisions for a member of a server.
 * Returns null when the user is not a member.
 */
export async function getMemberContext(
  db: Database,
  serverId: string,
  userId: string,
): Promise<MemberContext | null> {
  const [membership] = await db
    .select({ nickname: members.nickname })
    .from(members)
    .where(and(eq(members.serverId, serverId), eq(members.userId, userId)))
    .limit(1);

  if (!membership) return null;

  const [server] = await db
    .select({ ownerId: servers.ownerId })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);

  if (!server) return null;

  const serverRoles = await db
    .select({
      id: roles.id,
      permissions: roles.permissions,
      position: roles.position,
      isDefault: roles.isDefault,
    })
    .from(roles)
    .where(eq(roles.serverId, serverId));

  const held = await db
    .select({ roleId: memberRoles.roleId })
    .from(memberRoles)
    .where(and(eq(memberRoles.serverId, serverId), eq(memberRoles.userId, userId)));

  const heldIds = new Set(held.map((r) => r.roleId));
  const everyoneRole = serverRoles.find((r) => r.isDefault);

  if (!everyoneRole) {
    // Every server gets an @everyone role at creation; its absence means corrupt data.
    throw new Error(`Server ${serverId} has no @everyone role`);
  }

  const additionalRoles = serverRoles.filter((r) => !r.isDefault && heldIds.has(r.id));
  const isOwner = server.ownerId === userId;

  const permissions = resolveBasePermissions({
    isOwner,
    everyoneRolePermissions: everyoneRole.permissions,
    rolePermissions: additionalRoles.map((r) => r.permissions),
  });

  return {
    serverId,
    userId,
    isOwner,
    roleIds: additionalRoles.map((r) => r.id),
    everyoneRoleId: everyoneRole.id,
    permissions,
    highestRolePosition: isOwner
      ? Number.MAX_SAFE_INTEGER
      : additionalRoles.reduce((max, r) => Math.max(max, r.position), 0),
    nickname: membership.nickname,
  };
}

/** Like `getMemberContext`, but throws 403 instead of returning null. */
export async function requireMember(
  db: Database,
  serverId: string,
  userId: string,
): Promise<MemberContext> {
  const context = await getMemberContext(db, serverId, userId);
  if (!context) {
    // Deliberately "not found" rather than "forbidden": a non-member should not be able
    // to probe which server ids exist.
    throw ApiError.notFound('Server not found');
  }
  return context;
}

/** Throw unless the member holds every permission in `required`. */
export function assertPermission(
  context: MemberContext,
  required: PermissionBits,
  action: string,
): void {
  if (!hasPermission(context.permissions, required)) {
    throw ApiError.missingPermissions(`You need permission to ${action}`);
  }
}

export interface ChannelPermissionContext extends MemberContext {
  channelId: string;
  /** Permissions after channel overwrites have been applied. */
  channelPermissions: PermissionBits;
}

/**
 * Resolve permissions for a specific channel, applying its overwrites.
 *
 * DM channels have no server and no roles: participation *is* the permission. A
 * participant gets a fixed grant; a non-participant gets nothing.
 */
export async function getChannelPermissionContext(
  db: Database,
  channelId: string,
  userId: string,
): Promise<ChannelPermissionContext> {
  const [channel] = await db
    .select({ id: channels.id, serverId: channels.serverId, type: channels.type })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);

  if (!channel) throw ApiError.notFound('Channel not found');

  if (!channel.serverId) {
    const [participant] = await db
      .select({ userId: dmParticipants.userId })
      .from(dmParticipants)
      .where(
        and(eq(dmParticipants.channelId, channelId), eq(dmParticipants.userId, userId)),
      )
      .limit(1);

    if (!participant) throw ApiError.notFound('Channel not found');

    const dmPermissions =
      Permission.VIEW_CHANNEL |
      Permission.SEND_MESSAGES |
      Permission.READ_MESSAGE_HISTORY |
      Permission.ATTACH_FILES |
      Permission.ADD_REACTIONS |
      Permission.CONNECT |
      Permission.SPEAK |
      Permission.VIDEO;

    return {
      serverId: '',
      userId,
      isOwner: false,
      roleIds: [],
      everyoneRoleId: '',
      permissions: dmPermissions,
      highestRolePosition: 0,
      nickname: null,
      channelId,
      channelPermissions: dmPermissions,
    };
  }

  const context = await requireMember(db, channel.serverId, userId);

  const overwriteRows = await db
    .select()
    .from(channelOverwrites)
    .where(eq(channelOverwrites.channelId, channelId));

  const overwrites: PermissionOverwrite[] = overwriteRows.map((row) => ({
    targetType: row.targetType,
    targetId: row.targetId,
    allow: row.allow,
    deny: row.deny,
  }));

  const channelPermissions = resolveChannelPermissions(context.permissions, overwrites, {
    isOwner: context.isOwner,
    everyoneRoleId: context.everyoneRoleId,
    memberRoleIds: context.roleIds,
    memberId: userId,
  });

  return { ...context, channelId, channelPermissions };
}

/** Throw unless the member holds every permission in `required` *in this channel*. */
export function assertChannelPermission(
  context: ChannelPermissionContext,
  required: PermissionBits,
  action: string,
): void {
  if (!hasPermission(context.channelPermissions, required)) {
    // VIEW_CHANNEL is special: if you cannot see the channel, you should not learn that
    // it exists, so this reads as 404 rather than 403.
    if ((required & Permission.VIEW_CHANNEL) !== 0) {
      throw ApiError.notFound('Channel not found');
    }
    throw ApiError.missingPermissions(`You need permission to ${action}`);
  }
}

/**
 * Filter a list of channels down to the ones the member can see.
 * Used when building the sidebar and the initial ready payload.
 */
export async function filterVisibleChannels(
  db: Database,
  context: MemberContext,
  channelIds: string[],
): Promise<Set<string>> {
  if (channelIds.length === 0) return new Set();
  if (context.isOwner || hasPermission(context.permissions, Permission.ADMINISTRATOR)) {
    return new Set(channelIds);
  }

  const overwriteRows = await db
    .select()
    .from(channelOverwrites)
    .where(inArray(channelOverwrites.channelId, channelIds));

  const byChannel = new Map<string, PermissionOverwrite[]>();
  for (const row of overwriteRows) {
    const list = byChannel.get(row.channelId) ?? [];
    list.push({
      targetType: row.targetType,
      targetId: row.targetId,
      allow: row.allow,
      deny: row.deny,
    });
    byChannel.set(row.channelId, list);
  }

  const visible = new Set<string>();
  for (const channelId of channelIds) {
    const resolved = resolveChannelPermissions(
      context.permissions,
      byChannel.get(channelId) ?? [],
      {
        isOwner: context.isOwner,
        everyoneRoleId: context.everyoneRoleId,
        memberRoleIds: context.roleIds,
        memberId: context.userId,
      },
    );
    if (hasPermission(resolved, Permission.VIEW_CHANNEL)) visible.add(channelId);
  }
  return visible;
}

/**
 * Every member of a server who can actually see a given channel.
 *
 * This exists because realtime fan-out has two audiences: people with the channel *open*
 * (the channel room) and people who merely need their sidebar to light up (their personal
 * room). The second group must still be filtered by channel visibility, or a message in a
 * private channel would be delivered to members who cannot open it.
 *
 * Everything is loaded in a fixed number of queries and resolved in memory, so this costs
 * the same whether the server has 5 members or 500.
 */
export async function membersWhoCanViewChannel(
  db: Database,
  serverId: string,
  channelId: string,
): Promise<string[]> {
  const memberRows = await db
    .select({ userId: members.userId })
    .from(members)
    .where(eq(members.serverId, serverId));

  if (memberRows.length === 0) return [];

  const overwriteRows = await db
    .select()
    .from(channelOverwrites)
    .where(eq(channelOverwrites.channelId, channelId));

  const [server] = await db
    .select({ ownerId: servers.ownerId })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);

  const serverRoles = await db
    .select({
      id: roles.id,
      permissions: roles.permissions,
      isDefault: roles.isDefault,
    })
    .from(roles)
    .where(eq(roles.serverId, serverId));

  const everyoneRole = serverRoles.find((r) => r.isDefault);
  if (!everyoneRole) return [];

  // Fast path: with no overwrites, visibility is whatever @everyone grants, which is the
  // same answer for every member. No need to resolve per person.
  if (overwriteRows.length === 0) {
    const base = resolveBasePermissions({
      isOwner: false,
      everyoneRolePermissions: everyoneRole.permissions,
      rolePermissions: [],
    });
    if (hasPermission(base, Permission.VIEW_CHANNEL)) {
      return memberRows.map((m) => m.userId);
    }
  }

  const heldRows = await db
    .select({ userId: memberRoles.userId, roleId: memberRoles.roleId })
    .from(memberRoles)
    .where(eq(memberRoles.serverId, serverId));

  const rolesByUser = new Map<string, string[]>();
  for (const row of heldRows) {
    const list = rolesByUser.get(row.userId) ?? [];
    list.push(row.roleId);
    rolesByUser.set(row.userId, list);
  }

  const roleById = new Map(serverRoles.map((r) => [r.id, r]));
  const overwrites: PermissionOverwrite[] = overwriteRows.map((row) => ({
    targetType: row.targetType,
    targetId: row.targetId,
    allow: row.allow,
    deny: row.deny,
  }));

  const visible: string[] = [];

  for (const { userId } of memberRows) {
    const isOwner = server?.ownerId === userId;
    const heldIds = (rolesByUser.get(userId) ?? []).filter((id) => {
      const role = roleById.get(id);
      return role && !role.isDefault;
    });

    const base = resolveBasePermissions({
      isOwner,
      everyoneRolePermissions: everyoneRole.permissions,
      rolePermissions: heldIds.map((id) => roleById.get(id)!.permissions),
    });

    const resolved = resolveChannelPermissions(base, overwrites, {
      isOwner,
      everyoneRoleId: everyoneRole.id,
      memberRoleIds: heldIds,
      memberId: userId,
    });

    if (hasPermission(resolved, Permission.VIEW_CHANNEL)) visible.push(userId);
  }

  return visible;
}

/**
 * Role hierarchy check: you may only act on a member whose highest role sits strictly
 * below yours. Without this, any two moderators could kick each other, and a moderator
 * could grant themselves the owner's roles.
 */
export function assertHigherThan(
  actor: MemberContext,
  target: MemberContext,
  action: string,
): void {
  if (actor.isOwner) return;
  if (target.isOwner) {
    throw ApiError.missingPermissions(`You cannot ${action} the server owner`);
  }
  if (actor.highestRolePosition <= target.highestRolePosition) {
    throw ApiError.missingPermissions(
      `You cannot ${action} someone with a role equal to or higher than yours`,
    );
  }
}

/** Guard used before letting a user accept an invite. */
export async function assertNotBanned(
  db: Database,
  serverId: string,
  userId: string,
): Promise<void> {
  const [ban] = await db
    .select({ reason: bans.reason })
    .from(bans)
    .where(and(eq(bans.serverId, serverId), eq(bans.userId, userId)))
    .limit(1);

  if (ban) {
    throw new ApiError(403, 'BANNED', 'You are banned from this server');
  }
}

export { ALL_PERMISSIONS, Permission, hasPermission };
