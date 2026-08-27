/**
 * Client-side permission resolution.
 *
 * This reuses the *exact* resolver from `@rockscord/shared` that the server uses, so a
 * button is greyed out under precisely the conditions that would make the request fail.
 * There is no second implementation to drift.
 *
 * To be explicit about what this is for: it is presentation only. Every mutating route
 * re-resolves permissions server-side. Hiding a button is a courtesy, not a control.
 */

import { useMemo } from 'react';
import {
  Permission,
  hasPermission,
  resolveBasePermissions,
  resolveChannelPermissions,
  type PermissionBits,
} from '@rockscord/shared';
import { useAppStore } from '../store/useAppStore';

export interface PermissionResult {
  /** Server-wide bits, before channel overwrites. */
  base: PermissionBits;
  /** Bits for the channel in question, if one was given. */
  channel: PermissionBits;
  isOwner: boolean;
  can: (permission: PermissionBits) => boolean;
  /** Check against the server-wide bits, ignoring channel overwrites. */
  canInServer: (permission: PermissionBits) => boolean;
}

const NONE: PermissionResult = {
  base: 0,
  channel: 0,
  isOwner: false,
  can: () => false,
  canInServer: () => false,
};

/**
 * Resolve what the signed-in user may do in a server, and optionally in one of its
 * channels. DM channels get a fixed grant, matching the server's DM branch.
 */
export function usePermissions(
  serverId: string | null | undefined,
  channelId?: string | null,
): PermissionResult {
  const user = useAppStore((s) => s.user);
  const servers = useAppStore((s) => s.servers);
  const roles = useAppStore((s) => s.roles);
  const memberships = useAppStore((s) => s.memberships);
  const channels = useAppStore((s) => s.channels);
  const dmChannels = useAppStore((s) => s.dmChannels);

  return useMemo(() => {
    if (!user) return NONE;

    // A DM: participation is the permission.
    if (channelId && dmChannels[channelId]) {
      const bits =
        Permission.VIEW_CHANNEL |
        Permission.SEND_MESSAGES |
        Permission.READ_MESSAGE_HISTORY |
        Permission.ATTACH_FILES |
        Permission.ADD_REACTIONS |
        Permission.CONNECT |
        Permission.SPEAK |
        Permission.VIDEO;
      return {
        base: bits,
        channel: bits,
        isOwner: false,
        can: (permission) => hasPermission(bits, permission),
        canInServer: (permission) => hasPermission(bits, permission),
      };
    }

    if (!serverId) return NONE;

    const server = servers[serverId];
    const membership = memberships[serverId];
    if (!server || !membership) return NONE;

    const serverRoles = Object.values(roles).filter((role) => role.serverId === serverId);
    const everyoneRole = serverRoles.find((role) => role.isDefault);
    if (!everyoneRole) return NONE;

    const isOwner = server.ownerId === user.id;
    const heldRoles = serverRoles.filter(
      (role) => !role.isDefault && membership.roleIds.includes(role.id),
    );

    const base = resolveBasePermissions({
      isOwner,
      everyoneRolePermissions: everyoneRole.permissions,
      rolePermissions: heldRoles.map((role) => role.permissions),
    });

    let channel = base;
    const targetChannel = channelId ? channels[channelId] : null;
    if (targetChannel?.overwrites?.length) {
      channel = resolveChannelPermissions(base, targetChannel.overwrites, {
        isOwner,
        everyoneRoleId: everyoneRole.id,
        memberRoleIds: membership.roleIds,
        memberId: user.id,
      });
    }

    return {
      base,
      channel,
      isOwner,
      can: (permission) => hasPermission(channel, permission),
      canInServer: (permission) => hasPermission(base, permission),
    };
  }, [user, serverId, channelId, servers, roles, memberships, channels, dmChannels]);
}

/**
 * The highest role position the user holds in a server, used for hierarchy checks in the
 * UI (can I show a "Kick" item for this member?).
 */
export function useHighestRolePosition(serverId: string | null | undefined): number {
  const user = useAppStore((s) => s.user);
  const servers = useAppStore((s) => s.servers);
  const roles = useAppStore((s) => s.roles);
  const memberships = useAppStore((s) => s.memberships);

  return useMemo(() => {
    if (!serverId || !user) return 0;
    if (servers[serverId]?.ownerId === user.id) return Number.MAX_SAFE_INTEGER;

    const held = memberships[serverId]?.roleIds ?? [];
    return held.reduce((max, roleId) => Math.max(max, roles[roleId]?.position ?? 0), 0);
  }, [serverId, user, servers, roles, memberships]);
}

/** Highest role position of an arbitrary member, for comparing against the actor's. */
export function useMemberRolePosition(
  serverId: string | null | undefined,
  userId: string | null | undefined,
): number {
  const servers = useAppStore((s) => s.servers);
  const roles = useAppStore((s) => s.roles);
  const membersByServer = useAppStore((s) => s.membersByServer);

  return useMemo(() => {
    if (!serverId || !userId) return 0;
    if (servers[serverId]?.ownerId === userId) return Number.MAX_SAFE_INTEGER;

    const member = membersByServer[serverId]?.[userId];
    if (!member) return 0;
    return member.roleIds.reduce(
      (max, roleId) => Math.max(max, roles[roleId]?.position ?? 0),
      0,
    );
  }, [serverId, userId, servers, roles, membersByServer]);
}

/** The colour of a member's highest hoisted/coloured role, for name tinting. */
export function useMemberColor(
  serverId: string | null | undefined,
  userId: string | null | undefined,
): string | null {
  const roles = useAppStore((s) => s.roles);
  const membersByServer = useAppStore((s) => s.membersByServer);

  return useMemo(() => {
    if (!serverId || !userId) return null;
    const member = membersByServer[serverId]?.[userId];
    if (!member) return null;

    const coloured = member.roleIds
      .map((roleId) => roles[roleId])
      .filter((role): role is NonNullable<typeof role> => Boolean(role))
      // The default grey is treated as "no colour" so it never overrides a real one.
      .filter((role) => !role.isDefault && role.color !== '#99aab5')
      .sort((a, b) => b.position - a.position);

    return coloured[0]?.color ?? null;
  }, [serverId, userId, roles, membersByServer]);
}

export { Permission };
