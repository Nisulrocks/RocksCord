/**
 * Database schema (SQLite / libSQL dialect).
 *
 * Conventions used throughout:
 *  - Primary keys are ULIDs (see `lib/ids.ts`): 26-character, lexicographically sortable,
 *    time-ordered strings. Sortability is what lets message pagination be a plain
 *    `WHERE id < ? ORDER BY id DESC` keyset scan with no extra timestamp index.
 *  - Timestamps are integer milliseconds since the Unix epoch. Storing numbers rather
 *    than Drizzle's Date mode keeps them identical on the wire and in the DB.
 *  - Booleans are integers 0/1 with `mode: 'boolean'`.
 *  - Every foreign key declares its ON DELETE behaviour explicitly. Foreign keys are
 *    enforced at runtime (`PRAGMA foreign_keys = ON`, set in `db/index.ts`).
 */

import { relations, sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

const now = sql`(unixepoch() * 1000)`;

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    /** Lowercased copy of `username`, used for case-insensitive uniqueness and lookup. */
    usernameLower: text('username_lower').notNull(),
    username: text('username').notNull(),
    /** 4-digit tag so two people can both be "alex". Together they form alex#0417. */
    discriminator: text('discriminator').notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    avatarUrl: text('avatar_url'),
    bio: text('bio'),
    /** Last status the user explicitly chose; presence overlays "offline" when no socket. */
    status: text('status', { enum: ['online', 'idle', 'dnd', 'offline'] })
      .notNull()
      .default('online'),
    customStatus: text('custom_status'),
    lastSeenAt: integer('last_seen_at').notNull().default(now),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('users_email_unique').on(t.email),
    uniqueIndex('users_handle_unique').on(t.usernameLower, t.discriminator),
    index('users_username_lower_idx').on(t.usernameLower),
  ],
);

/**
 * One row per active refresh token. Storing a SHA-256 hash (never the token itself)
 * means a database leak cannot be replayed to mint access tokens. Rotation replaces the
 * row, so a stolen-and-reused token is detectable as a revoked-token hit.
 */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
    createdAt: integer('created_at').notNull().default(now),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_unique').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
    index('sessions_expires_idx').on(t.expiresAt),
  ],
);

/* -------------------------------------------------------------------------- */
/* Servers, roles, membership                                                  */
/* -------------------------------------------------------------------------- */

export const servers = sqliteTable(
  'servers',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    iconUrl: text('icon_url'),
    description: text('description'),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [index('servers_owner_idx').on(t.ownerId)],
);

export const roles = sqliteTable(
  'roles',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull().default('#99aab5'),
    permissions: integer('permissions').notNull().default(0),
    /** Higher wins in the hierarchy. @everyone is pinned at 0. */
    position: integer('position').notNull().default(0),
    hoist: integer('hoist', { mode: 'boolean' }).notNull().default(false),
    mentionable: integer('mentionable', { mode: 'boolean' }).notNull().default(false),
    /** Exactly one per server: the undeletable @everyone role. */
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('roles_server_idx').on(t.serverId)],
);

export const members = sqliteTable(
  'members',
  {
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    nickname: text('nickname'),
    joinedAt: integer('joined_at').notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.serverId, t.userId] }),
    index('members_user_idx').on(t.userId),
  ],
);

export const memberRoles = sqliteTable(
  'member_roles',
  {
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.serverId, t.userId, t.roleId] }),
    index('member_roles_role_idx').on(t.roleId),
  ],
);

export const bans = sqliteTable(
  'bans',
  {
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reason: text('reason'),
    bannedById: text('banned_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.userId] })],
);

/* -------------------------------------------------------------------------- */
/* Channels                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Text channels, voice channels, and DM conversations all live here. A DM has
 * `serverId = NULL` and its participants in `dmParticipants`. Keeping one table means
 * messages, attachments, read state, and search work identically in servers and DMs.
 */
export const channels = sqliteTable(
  'channels',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id').references(() => servers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type', { enum: ['text', 'voice', 'dm'] })
      .notNull()
      .default('text'),
    topic: text('topic'),
    position: integer('position').notNull().default(0),
    /** Denormalised for sorting the DM list without a correlated subquery. */
    lastMessageAt: integer('last_message_at'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [
    index('channels_server_idx').on(t.serverId),
    index('channels_last_message_idx').on(t.lastMessageAt),
  ],
);

export const channelOverwrites = sqliteTable(
  'channel_overwrites',
  {
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    targetType: text('target_type', { enum: ['role', 'member'] }).notNull(),
    /** A role id or a user id, depending on `targetType`. */
    targetId: text('target_id').notNull(),
    allow: integer('allow').notNull().default(0),
    deny: integer('deny').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.targetType, t.targetId] })],
);

export const dmParticipants = sqliteTable(
  'dm_participants',
  {
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Lets a user hide a DM from their sidebar without destroying the history. */
    closed: integer('closed', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.userId] }),
    index('dm_participants_user_idx').on(t.userId),
  ],
);

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    authorId: text('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    content: text('content').notNull().default(''),
    /**
     * Deleting is a tombstone, not a row removal: replies that point at this message
     * still need something to render, and hard deletes would cascade them away.
     */
    deleted: integer('deleted', { mode: 'boolean' }).notNull().default(false),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    mentionsEveryone: integer('mentions_everyone', { mode: 'boolean' })
      .notNull()
      .default(false),
    replyToId: text('reply_to_id'),
    createdAt: integer('created_at').notNull().default(now),
    editedAt: integer('edited_at'),
  },
  (t) => [
    // The single most important index in the app: every channel scroll uses it.
    index('messages_channel_id_idx').on(t.channelId, t.id),
    index('messages_author_idx').on(t.authorId),
    index('messages_reply_idx').on(t.replyToId),
  ],
);

export const messageMentions = sqliteTable(
  'message_mentions',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.userId] }),
    index('message_mentions_user_idx').on(t.userId),
  ],
);

export const reactions = sqliteTable(
  'reactions',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId, t.emoji] })],
);

/**
 * Uploads are recorded the moment the file lands, before the message exists. The
 * `messageId` stays NULL until the message referencing it is created, which lets the
 * composer upload in the background while the user is still typing. Orphaned rows
 * (upload started, message never sent) are swept by a periodic job.
 */
export const attachments = sqliteTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id').references(() => messages.id, { onDelete: 'cascade' }),
    uploaderId: text('uploader_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    /** Path within the active storage driver (local disk key or Supabase object key). */
    storageKey: text('storage_key').notNull(),
    width: integer('width'),
    height: integer('height'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [
    index('attachments_message_idx').on(t.messageId),
    index('attachments_uploader_idx').on(t.uploaderId),
  ],
);

/* -------------------------------------------------------------------------- */
/* Social                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A single row represents the relationship in both directions. `requesterId` is the one
 * who initiated, which is what tells the UI whether to show "Accept / Reject" or "Cancel".
 * The unique index is on the *ordered* pair so A->B and B->A cannot both exist.
 */
export const friendships = sqliteTable(
  'friendships',
  {
    id: text('id').primaryKey(),
    requesterId: text('requester_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    addresseeId: text('addressee_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Lexicographically smaller of the two ids -- half of the uniqueness key. */
    userLowId: text('user_low_id').notNull(),
    userHighId: text('user_high_id').notNull(),
    status: text('status', { enum: ['pending', 'accepted', 'blocked'] })
      .notNull()
      .default('pending'),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('friendships_pair_unique').on(t.userLowId, t.userHighId),
    index('friendships_requester_idx').on(t.requesterId),
    index('friendships_addressee_idx').on(t.addresseeId),
  ],
);

export const invites = sqliteTable(
  'invites',
  {
    code: text('code').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    inviterId: text('inviter_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    uses: integer('uses').notNull().default(0),
    maxUses: integer('max_uses'),
    expiresAt: integer('expires_at'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('invites_server_idx').on(t.serverId)],
);

/* -------------------------------------------------------------------------- */
/* Read state & notifications                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Unread state is derived, not stored: because ids are time-sortable, "unread" is simply
 * `channel.lastMessageId > readState.lastReadMessageId`. Only the mention counter needs
 * to be maintained incrementally, since counting mentions on read would be a scan.
 */
export const readStates = sqliteTable(
  'read_states',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    lastReadMessageId: text('last_read_message_id'),
    mentionCount: integer('mention_count').notNull().default(0),
    /** Suppress all notifications for this channel. */
    muted: integer('muted', { mode: 'boolean' }).notNull().default(false),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.channelId] }),
    index('read_states_channel_idx').on(t.channelId),
  ],
);

export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type', {
      enum: ['mention', 'dm', 'friend_request', 'server_invite'],
    }).notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    serverId: text('server_id'),
    channelId: text('channel_id'),
    messageId: text('message_id'),
    read: integer('read', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.read)],
);

/** Append-only moderation trail, surfaced under Server Settings -> Audit Log. */
export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    /** JSON blob of before/after values; shape varies per action. */
    metadata: text('metadata'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('audit_logs_server_idx').on(t.serverId, t.createdAt)],
);

/* -------------------------------------------------------------------------- */
/* Relations (for Drizzle's relational query API)                              */
/* -------------------------------------------------------------------------- */

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  memberships: many(members),
  messages: many(messages),
}));

export const serversRelations = relations(servers, ({ one, many }) => ({
  owner: one(users, { fields: [servers.ownerId], references: [users.id] }),
  channels: many(channels),
  roles: many(roles),
  members: many(members),
}));

export const channelsRelations = relations(channels, ({ one, many }) => ({
  server: one(servers, { fields: [channels.serverId], references: [servers.id] }),
  messages: many(messages),
  overwrites: many(channelOverwrites),
  participants: many(dmParticipants),
}));

export const messagesRelations = relations(messages, ({ one, many }) => ({
  channel: one(channels, { fields: [messages.channelId], references: [channels.id] }),
  author: one(users, { fields: [messages.authorId], references: [users.id] }),
  attachments: many(attachments),
  reactions: many(reactions),
  mentions: many(messageMentions),
}));

export const membersRelations = relations(members, ({ one, many }) => ({
  user: one(users, { fields: [members.userId], references: [users.id] }),
  server: one(servers, { fields: [members.serverId], references: [servers.id] }),
  roles: many(memberRoles),
}));

export const memberRolesRelations = relations(memberRoles, ({ one }) => ({
  role: one(roles, { fields: [memberRoles.roleId], references: [roles.id] }),
}));

export const attachmentsRelations = relations(attachments, ({ one }) => ({
  message: one(messages, { fields: [attachments.messageId], references: [messages.id] }),
}));

/* -------------------------------------------------------------------------- */
/* Inferred row types                                                          */
/* -------------------------------------------------------------------------- */

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type ServerRow = typeof servers.$inferSelect;
export type ChannelRow = typeof channels.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type RoleRow = typeof roles.$inferSelect;
export type MemberRow = typeof members.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;
export type FriendshipRow = typeof friendships.$inferSelect;
export type InviteRow = typeof invites.$inferSelect;
export type ReadStateRow = typeof readStates.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
