/**
 * Permission system.
 *
 * Permissions are a 32-bit integer bitfield. We deliberately stay under bit 31 so that
 * plain JavaScript bitwise operators (`|`, `&`, `~`) work without BigInt ceremony, which
 * keeps the client-side permission checks cheap and readable.
 *
 * Resolution order (mirrors how real chat platforms do it, simplified):
 *   1. Server owner            -> all permissions, always.
 *   2. @everyone role base permissions.
 *   3. OR in every additional role the member has.
 *   4. If ADMINISTRATOR is present -> all permissions, stop here.
 *   5. Apply channel overwrites: @everyone overwrite, then role overwrites (denies
 *      collected first, then allows), then the member-specific overwrite last.
 */

export const Permission = {
  /** See the channel in the sidebar and read its content. */
  VIEW_CHANNEL: 1 << 0,
  /** Post new messages. */
  SEND_MESSAGES: 1 << 1,
  /** Load messages sent before you joined / opened the channel. */
  READ_MESSAGE_HISTORY: 1 << 2,
  /** Delete or pin *other people's* messages. Your own are always yours to delete. */
  MANAGE_MESSAGES: 1 << 3,
  /** Upload files and images. */
  ATTACH_FILES: 1 << 4,
  /** React to messages with emoji. */
  ADD_REACTIONS: 1 << 5,
  /** Use @everyone / @here. */
  MENTION_EVERYONE: 1 << 6,
  /** Create, delete, and rename channels; edit channel overwrites. */
  MANAGE_CHANNELS: 1 << 7,
  /** Create and edit roles at or below your highest role's position. */
  MANAGE_ROLES: 1 << 8,
  /** Change the server name, icon, and settings. */
  MANAGE_SERVER: 1 << 9,
  /** Remove members (they can rejoin with a new invite). */
  KICK_MEMBERS: 1 << 10,
  /** Remove members permanently. */
  BAN_MEMBERS: 1 << 11,
  /** Generate invite links. */
  CREATE_INVITE: 1 << 12,
  /** Change other members' nicknames. */
  MANAGE_NICKNAMES: 1 << 13,
  /** Join voice channels. */
  CONNECT: 1 << 14,
  /** Transmit audio in voice channels. */
  SPEAK: 1 << 15,
  /** Share your screen in a voice channel. */
  VIDEO: 1 << 16,
  /** Server-mute other members. */
  MUTE_MEMBERS: 1 << 17,
  /** Server-deafen other members. */
  DEAFEN_MEMBERS: 1 << 18,
  /** Disconnect members from voice. */
  MOVE_MEMBERS: 1 << 19,
  /** Read the moderation audit log. */
  VIEW_AUDIT_LOG: 1 << 20,
  /** Bypasses every check below owner. Grant with care. */
  ADMINISTRATOR: 1 << 21,
} as const;

export type PermissionName = keyof typeof Permission;
export type PermissionBits = number;

/** Every permission OR'd together. Used for owners and administrators. */
export const ALL_PERMISSIONS: PermissionBits = Object.values(Permission).reduce(
  (acc, bit) => acc | bit,
  0,
);

/**
 * What a brand-new member can do in a brand-new server. Intentionally conservative:
 * they can talk and use voice, but cannot manage anything or ping everyone.
 */
export const DEFAULT_EVERYONE_PERMISSIONS: PermissionBits =
  Permission.VIEW_CHANNEL |
  Permission.SEND_MESSAGES |
  Permission.READ_MESSAGE_HISTORY |
  Permission.ATTACH_FILES |
  Permission.ADD_REACTIONS |
  Permission.CREATE_INVITE |
  Permission.CONNECT |
  Permission.SPEAK |
  Permission.VIDEO;

/** Preset used by the "Moderator" role the seeder creates. */
export const MODERATOR_PERMISSIONS: PermissionBits =
  DEFAULT_EVERYONE_PERMISSIONS |
  Permission.MANAGE_MESSAGES |
  Permission.KICK_MEMBERS |
  Permission.MENTION_EVERYONE |
  Permission.MUTE_MEMBERS |
  Permission.DEAFEN_MEMBERS |
  Permission.MOVE_MEMBERS |
  Permission.VIEW_AUDIT_LOG;

/** Preset used by the "Admin" role the seeder creates. */
export const ADMIN_PERMISSIONS: PermissionBits =
  MODERATOR_PERMISSIONS |
  Permission.MANAGE_CHANNELS |
  Permission.MANAGE_ROLES |
  Permission.MANAGE_SERVER |
  Permission.BAN_MEMBERS |
  Permission.MANAGE_NICKNAMES;

/** True if `bits` contains every permission in `required`. */
export function hasPermission(bits: PermissionBits, required: PermissionBits): boolean {
  if ((bits & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR) return true;
  return (bits & required) === required;
}

/** True if `bits` contains at least one of the permissions in `required`. */
export function hasAnyPermission(bits: PermissionBits, required: PermissionBits): boolean {
  if ((bits & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR) return true;
  return (bits & required) !== 0;
}

/** Expand a bitfield into its permission names. Used by the UI and audit log. */
export function listPermissions(bits: PermissionBits): PermissionName[] {
  return (Object.keys(Permission) as PermissionName[]).filter(
    (name) => (bits & Permission[name]) !== 0,
  );
}

/** Collapse a list of permission names into a bitfield. */
export function packPermissions(names: readonly PermissionName[]): PermissionBits {
  return names.reduce<PermissionBits>((acc, name) => acc | (Permission[name] ?? 0), 0);
}

/** A single channel permission overwrite for a role or a member. */
export interface PermissionOverwrite {
  targetType: 'role' | 'member';
  targetId: string;
  allow: PermissionBits;
  deny: PermissionBits;
}

export interface ResolveContext {
  /** The server owner bypasses everything. */
  isOwner: boolean;
  /** Permission bits of the @everyone role. */
  everyoneRolePermissions: PermissionBits;
  /** Permission bits of each additional role the member holds. */
  rolePermissions: readonly PermissionBits[];
}

/** Resolve a member's server-wide (channel-independent) permissions. */
export function resolveBasePermissions(ctx: ResolveContext): PermissionBits {
  if (ctx.isOwner) return ALL_PERMISSIONS;
  let bits = ctx.everyoneRolePermissions;
  for (const rolePerms of ctx.rolePermissions) bits |= rolePerms;
  if ((bits & Permission.ADMINISTRATOR) !== 0) return ALL_PERMISSIONS;
  return bits;
}

/**
 * Apply channel overwrites on top of base permissions.
 *
 * `everyoneRoleId` is the id of the @everyone role so it can be applied first, and
 * `memberRoleIds` must contain every role id the member holds (excluding @everyone).
 */
export function resolveChannelPermissions(
  basePermissions: PermissionBits,
  overwrites: readonly PermissionOverwrite[],
  opts: {
    isOwner: boolean;
    everyoneRoleId: string;
    memberRoleIds: readonly string[];
    memberId: string;
  },
): PermissionBits {
  if (opts.isOwner) return ALL_PERMISSIONS;
  if ((basePermissions & Permission.ADMINISTRATOR) !== 0) return ALL_PERMISSIONS;

  let bits = basePermissions;

  const everyoneOverwrite = overwrites.find(
    (o) => o.targetType === 'role' && o.targetId === opts.everyoneRoleId,
  );
  if (everyoneOverwrite) {
    bits &= ~everyoneOverwrite.deny;
    bits |= everyoneOverwrite.allow;
  }

  // Role overwrites are accumulated so that a single allow anywhere beats a deny
  // elsewhere -- matching the behaviour users expect from familiar chat apps.
  let roleAllow = 0;
  let roleDeny = 0;
  for (const o of overwrites) {
    if (o.targetType !== 'role') continue;
    if (o.targetId === opts.everyoneRoleId) continue;
    if (!opts.memberRoleIds.includes(o.targetId)) continue;
    roleAllow |= o.allow;
    roleDeny |= o.deny;
  }
  bits &= ~roleDeny;
  bits |= roleAllow;

  // The member-specific overwrite is the most specific rule, so it wins outright.
  const memberOverwrite = overwrites.find(
    (o) => o.targetType === 'member' && o.targetId === opts.memberId,
  );
  if (memberOverwrite) {
    bits &= ~memberOverwrite.deny;
    bits |= memberOverwrite.allow;
  }

  return bits;
}
