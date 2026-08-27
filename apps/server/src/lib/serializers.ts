/**
 * Row -> wire DTO conversion.
 *
 * Two responsibilities:
 *
 *  1. **Never leak.** `toPublicUser` is the only way a user reaches another user's
 *     client, and it physically cannot carry `passwordHash` or `email` because it builds
 *     a fresh object with an explicit field list rather than spreading the row.
 *
 *  2. **Never N+1.** `hydrateMessages` takes a *page* of message rows and issues a fixed
 *     number of queries (authors, attachments, reactions, mentions, reply targets)
 *     regardless of page size. Loading 50 messages costs 6 queries, not 250.
 */

import { inArray, and, eq } from 'drizzle-orm';
import type {
  Attachment,
  Channel,
  ChannelOverwrite,
  DMChannel,
  Friendship,
  Invite,
  Member,
  Message,
  MessagePreview,
  PublicUser,
  Reaction,
  Role,
  SelfUser,
  Server,
} from '@rockscord/shared';
import type { Database } from '../db/index.js';
import {
  attachments as attachmentsTable,
  channelOverwrites as overwritesTable,
  channels as channelsTable,
  dmParticipants,
  memberRoles,
  messageMentions,
  messages as messagesTable,
  reactions as reactionsTable,
  users as usersTable,
  type AttachmentRow,
  type ChannelRow,
  type FriendshipRow,
  type InviteRow,
  type MemberRow,
  type MessageRow,
  type RoleRow,
  type ServerRow,
  type UserRow,
} from '../db/schema.js';
import { getStorage } from './storage/index.js';
import * as presence from '../realtime/presence.js';

/** The subset of user columns that is safe to send to any client. */
export const publicUserColumns = {
  id: usersTable.id,
  username: usersTable.username,
  displayName: usersTable.displayName,
  discriminator: usersTable.discriminator,
  avatarUrl: usersTable.avatarUrl,
  bio: usersTable.bio,
  status: usersTable.status,
  customStatus: usersTable.customStatus,
  createdAt: usersTable.createdAt,
} as const;

export type PublicUserRow = {
  [K in keyof typeof publicUserColumns]: UserRow[K];
};

/**
 * Project a user row for public consumption.
 *
 * The stored `status` is the user's *preference*; what other people should see is their
 * live presence, so the registry overrides it. A user who picked "Do Not Disturb" and
 * then closed the app is offline, not DND.
 */
export function toPublicUser(row: PublicUserRow | UserRow): PublicUser {
  const live = presence.getSnapshot(row.id);
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    discriminator: row.discriminator,
    avatarUrl: row.avatarUrl,
    bio: row.bio,
    status: live.status,
    customStatus: live.customStatus ?? row.customStatus,
    createdAt: row.createdAt,
  };
}

/** Adds the fields a user is allowed to see about themselves. */
export function toSelfUser(row: UserRow): SelfUser {
  return {
    ...toPublicUser(row),
    email: row.email,
    emailVerified: row.emailVerifiedAt !== null,
  };
}

export function toServer(row: ServerRow, memberCount?: number): Server {
  return {
    id: row.id,
    name: row.name,
    iconUrl: row.iconUrl,
    description: row.description,
    ownerId: row.ownerId,
    createdAt: row.createdAt,
    ...(memberCount === undefined ? {} : { memberCount }),
  };
}

export function toRole(row: RoleRow): Role {
  return {
    id: row.id,
    serverId: row.serverId,
    name: row.name,
    color: row.color,
    permissions: row.permissions,
    position: row.position,
    hoist: row.hoist,
    mentionable: row.mentionable,
    isDefault: row.isDefault,
  };
}

export function toChannel(row: ChannelRow, overwrites?: ChannelOverwrite[]): Channel {
  return {
    id: row.id,
    serverId: row.serverId ?? '',
    name: row.name,
    type: row.type === 'voice' ? 'voice' : 'text',
    topic: row.topic,
    position: row.position,
    createdAt: row.createdAt,
    ...(overwrites ? { overwrites } : {}),
  };
}

export function toMember(
  row: MemberRow,
  user: PublicUserRow | UserRow,
  roleIds: string[],
): Member {
  return {
    userId: row.userId,
    serverId: row.serverId,
    nickname: row.nickname,
    roleIds,
    joinedAt: row.joinedAt,
    user: toPublicUser(user),
  };
}

export function toInvite(
  row: InviteRow,
  server?: Server & { memberCount: number },
): Invite {
  return {
    code: row.code,
    serverId: row.serverId,
    inviterId: row.inviterId,
    uses: row.uses,
    maxUses: row.maxUses,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    ...(server
      ? {
          server: {
            id: server.id,
            name: server.name,
            iconUrl: server.iconUrl,
            description: server.description,
            memberCount: server.memberCount,
          },
        }
      : {}),
  };
}

export function toFriendship(row: FriendshipRow, other: PublicUserRow | UserRow): Friendship {
  return {
    id: row.id,
    status: row.status,
    requesterId: row.requesterId,
    user: toPublicUser(other),
    createdAt: row.createdAt,
  };
}

export async function toAttachment(row: AttachmentRow): Promise<Attachment> {
  const storage = await getStorage();
  return {
    id: row.id,
    fileName: row.fileName,
    size: row.size,
    contentType: row.contentType,
    url: storage.urlFor(row.storageKey),
    width: row.width,
    height: row.height,
  };
}

/* -------------------------------------------------------------------------- */
/* Message hydration                                                           */
/* -------------------------------------------------------------------------- */

/** Load the public projection of many users at once, keyed by id. */
export async function loadUsers(
  db: Database,
  userIds: readonly string[],
): Promise<Map<string, PublicUserRow>> {
  const unique = [...new Set(userIds)].filter(Boolean);
  if (unique.length === 0) return new Map();

  const rows = await db
    .select(publicUserColumns)
    .from(usersTable)
    .where(inArray(usersTable.id, unique));

  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * A deleted author would break rendering, and a user row can genuinely be missing if the
 * account was removed mid-page-load. Render a stable placeholder instead of throwing.
 */
const DELETED_USER = (id: string): PublicUser => ({
  id,
  username: 'deleted-user',
  displayName: 'Deleted User',
  discriminator: '0000',
  avatarUrl: null,
  bio: null,
  status: 'offline',
  customStatus: null,
  createdAt: 0,
});

/**
 * Turn a page of message rows into fully-populated `Message` DTOs.
 *
 * Query budget, independent of how many messages are in the page:
 *   1. reply-target rows      2. all authors (incl. reply authors)
 *   3. attachments            4. reactions
 *   5. mentions               (+1 lazy storage init)
 */
export async function hydrateMessages(
  db: Database,
  rows: readonly MessageRow[],
  viewerId: string,
): Promise<Message[]> {
  if (rows.length === 0) return [];

  const messageIds = rows.map((r) => r.id);

  const replyTargetIds = [
    ...new Set(rows.map((r) => r.replyToId).filter((id): id is string => Boolean(id))),
  ];

  const replyRows = replyTargetIds.length
    ? await db
        .select({
          id: messagesTable.id,
          authorId: messagesTable.authorId,
          content: messagesTable.content,
          deleted: messagesTable.deleted,
        })
        .from(messagesTable)
        .where(inArray(messagesTable.id, replyTargetIds))
    : [];

  const userMap = await loadUsers(db, [
    ...rows.map((r) => r.authorId),
    ...replyRows.map((r) => r.authorId),
  ]);

  const attachmentRows = await db
    .select()
    .from(attachmentsTable)
    .where(inArray(attachmentsTable.messageId, messageIds));

  const reactionRows = await db
    .select()
    .from(reactionsTable)
    .where(inArray(reactionsTable.messageId, messageIds));

  const mentionRows = await db
    .select()
    .from(messageMentions)
    .where(inArray(messageMentions.messageId, messageIds));

  const storage = await getStorage();

  const attachmentsByMessage = new Map<string, Attachment[]>();
  for (const row of attachmentRows) {
    if (!row.messageId) continue;
    const list = attachmentsByMessage.get(row.messageId) ?? [];
    list.push({
      id: row.id,
      fileName: row.fileName,
      size: row.size,
      contentType: row.contentType,
      url: storage.urlFor(row.storageKey),
      width: row.width,
      height: row.height,
    });
    attachmentsByMessage.set(row.messageId, list);
  }

  // Reactions collapse into {emoji, count, me} per message.
  const reactionsByMessage = new Map<string, Map<string, Reaction>>();
  for (const row of reactionRows) {
    const perMessage = reactionsByMessage.get(row.messageId) ?? new Map<string, Reaction>();
    const existing = perMessage.get(row.emoji) ?? { emoji: row.emoji, count: 0, me: false };
    existing.count += 1;
    if (row.userId === viewerId) existing.me = true;
    perMessage.set(row.emoji, existing);
    reactionsByMessage.set(row.messageId, perMessage);
  }

  const mentionsByMessage = new Map<string, string[]>();
  for (const row of mentionRows) {
    const list = mentionsByMessage.get(row.messageId) ?? [];
    list.push(row.userId);
    mentionsByMessage.set(row.messageId, list);
  }

  const replyMap = new Map<string, MessagePreview>();
  for (const row of replyRows) {
    const author = userMap.get(row.authorId);
    replyMap.set(row.id, {
      id: row.id,
      authorId: row.authorId,
      author: author ? toPublicUser(author) : DELETED_USER(row.authorId),
      // A reply preview of a deleted message shows a tombstone, not the old text.
      content: row.deleted ? '' : row.content.slice(0, 200),
      deleted: row.deleted,
    });
  }

  return rows.map((row) => {
    const authorRow = userMap.get(row.authorId);
    return {
      id: row.id,
      channelId: row.channelId,
      authorId: row.authorId,
      author: authorRow ? toPublicUser(authorRow) : DELETED_USER(row.authorId),
      content: row.deleted ? '' : row.content,
      createdAt: row.createdAt,
      editedAt: row.editedAt,
      replyToId: row.replyToId,
      replyTo: row.replyToId ? (replyMap.get(row.replyToId) ?? null) : null,
      attachments: row.deleted ? [] : (attachmentsByMessage.get(row.id) ?? []),
      reactions: row.deleted
        ? []
        : [...(reactionsByMessage.get(row.id)?.values() ?? [])].sort((a, b) =>
            a.emoji.localeCompare(b.emoji),
          ),
      mentionUserIds: mentionsByMessage.get(row.id) ?? [],
      mentionsEveryone: row.mentionsEveryone,
      pinned: row.pinned,
      deleted: row.deleted,
    };
  });
}

/** Convenience wrapper for the very common "just created one message" case. */
export async function hydrateMessage(
  db: Database,
  row: MessageRow,
  viewerId: string,
): Promise<Message> {
  const [message] = await hydrateMessages(db, [row], viewerId);
  return message!;
}

/** Build the DM DTOs for a user, with the other participants attached. */
export async function loadDMChannels(
  db: Database,
  userId: string,
): Promise<DMChannel[]> {
  const memberships = await db
    .select({ channelId: dmParticipants.channelId })
    .from(dmParticipants)
    .where(and(eq(dmParticipants.userId, userId), eq(dmParticipants.closed, false)));

  const channelIds = memberships.map((m) => m.channelId);
  if (channelIds.length === 0) return [];

  const channelRows = await db
    .select()
    .from(channelsTable)
    .where(inArray(channelsTable.id, channelIds));

  const participantRows = await db
    .select()
    .from(dmParticipants)
    .where(inArray(dmParticipants.channelId, channelIds));

  const userMap = await loadUsers(
    db,
    participantRows.map((p) => p.userId),
  );

  const byChannel = new Map<string, PublicUser[]>();
  for (const row of participantRows) {
    if (row.userId === userId) continue; // "recipients" means everyone but me
    const user = userMap.get(row.userId);
    if (!user) continue;
    const list = byChannel.get(row.channelId) ?? [];
    list.push(toPublicUser(user));
    byChannel.set(row.channelId, list);
  }

  return channelRows
    .map((row) => ({
      id: row.id,
      type: 'dm' as const,
      recipients: byChannel.get(row.id) ?? [],
      lastMessageAt: row.lastMessageAt,
      createdAt: row.createdAt,
    }))
    .sort((a, b) => (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt));
}

/** Load channel permission overwrites, grouped by channel. */
export async function loadOverwrites(
  db: Database,
  channelIds: string[],
): Promise<Map<string, ChannelOverwrite[]>> {
  if (channelIds.length === 0) return new Map();

  const rows = await db
    .select()
    .from(overwritesTable)
    .where(inArray(overwritesTable.channelId, channelIds));

  const map = new Map<string, ChannelOverwrite[]>();
  for (const row of rows) {
    const list = map.get(row.channelId) ?? [];
    list.push({
      channelId: row.channelId,
      targetType: row.targetType,
      targetId: row.targetId,
      allow: row.allow,
      deny: row.deny,
    });
    map.set(row.channelId, list);
  }
  return map;
}

/** Role ids per member for a whole server, in one query. */
export async function loadMemberRoleIds(
  db: Database,
  serverId: string,
): Promise<Map<string, string[]>> {
  const rows = await db
    .select({ userId: memberRoles.userId, roleId: memberRoles.roleId })
    .from(memberRoles)
    .where(eq(memberRoles.serverId, serverId));

  const map = new Map<string, string[]>();
  for (const row of rows) {
    const list = map.get(row.userId) ?? [];
    list.push(row.roleId);
    map.set(row.userId, list);
  }
  return map;
}
