/**
 * Request validation schemas.
 *
 * The server runs every request body through these before touching the database, and the
 * client reuses the exact same schemas for inline form validation. One definition, two
 * consumers, no drift.
 */

import { z } from 'zod';
import { LIMITS, RESERVED_USERNAMES } from './constants.js';

/** Usernames are lowercase-insensitive handles: letters, digits, underscore, dot, dash. */
export const usernameSchema = z
  .string()
  .trim()
  .min(LIMITS.USERNAME_MIN, `Username must be at least ${LIMITS.USERNAME_MIN} characters`)
  .max(LIMITS.USERNAME_MAX, `Username must be at most ${LIMITS.USERNAME_MAX} characters`)
  .regex(
    /^[a-zA-Z0-9._-]+$/,
    'Username may only contain letters, numbers, and . _ -',
  )
  .refine(
    (v) => !RESERVED_USERNAMES.has(v.toLowerCase()),
    'That username is reserved',
  );

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Enter a valid email address');

export const passwordSchema = z
  .string()
  .min(LIMITS.PASSWORD_MIN, `Password must be at least ${LIMITS.PASSWORD_MIN} characters`)
  .max(LIMITS.PASSWORD_MAX, `Password must be at most ${LIMITS.PASSWORD_MAX} characters`);

export const registerSchema = z.object({
  email: emailSchema,
  username: usernameSchema,
  displayName: z.string().trim().max(LIMITS.DISPLAY_NAME_MAX).optional(),
  password: passwordSchema,
});

export const loginSchema = z.object({
  /** Accepts either the email address or the username. */
  identifier: z.string().trim().min(1, 'Enter your email or username').max(254),
  password: z.string().min(1, 'Enter your password').max(LIMITS.PASSWORD_MAX),
});

export const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(LIMITS.DISPLAY_NAME_MAX).optional(),
  bio: z.string().trim().max(LIMITS.BIO_MAX).nullable().optional(),
  customStatus: z.string().trim().max(LIMITS.CUSTOM_STATUS_MAX).nullable().optional(),
  status: z.enum(['online', 'idle', 'dnd', 'offline']).optional(),
  avatarUrl: z.string().max(1024).nullable().optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(LIMITS.PASSWORD_MAX),
  newPassword: passwordSchema,
});

export const createServerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(LIMITS.SERVER_NAME_MIN)
    .max(LIMITS.SERVER_NAME_MAX),
  description: z.string().trim().max(LIMITS.SERVER_DESCRIPTION_MAX).nullable().optional(),
  iconUrl: z.string().max(1024).nullable().optional(),
});

export const updateServerSchema = createServerSchema.partial();

/** Channel names are normalised to a slug-like form for text channels. */
export const channelNameSchema = z
  .string()
  .trim()
  .min(LIMITS.CHANNEL_NAME_MIN)
  .max(LIMITS.CHANNEL_NAME_MAX)
  .regex(/^[^\n\r\t]+$/, 'Channel names cannot contain line breaks');

export const createChannelSchema = z.object({
  name: channelNameSchema,
  type: z.enum(['text', 'voice']).default('text'),
  topic: z.string().trim().max(LIMITS.CHANNEL_TOPIC_MAX).nullable().optional(),
});

export const updateChannelSchema = z.object({
  name: channelNameSchema.optional(),
  topic: z.string().trim().max(LIMITS.CHANNEL_TOPIC_MAX).nullable().optional(),
  position: z.number().int().min(0).max(1000).optional(),
});

export const channelOverwriteSchema = z.object({
  targetType: z.enum(['role', 'member']),
  targetId: z.string().min(1).max(64),
  allow: z.number().int().min(0),
  deny: z.number().int().min(0),
});

export const createMessageSchema = z
  .object({
    content: z.string().max(LIMITS.MESSAGE_MAX).default(''),
    replyToId: z.string().min(1).max(64).nullable().optional(),
    attachmentIds: z
      .array(z.string().min(1).max(64))
      .max(LIMITS.MAX_ATTACHMENTS_PER_MESSAGE)
      .optional(),
    /** Echoed back on the created message so the sender can reconcile its optimistic copy. */
    nonce: z.string().max(64).optional(),
  })
  .refine(
    (v) => v.content.trim().length > 0 || (v.attachmentIds?.length ?? 0) > 0,
    { message: 'A message needs text or an attachment', path: ['content'] },
  );

export const editMessageSchema = z.object({
  content: z.string().trim().min(1).max(LIMITS.MESSAGE_MAX),
});

export const listMessagesSchema = z.object({
  /** Fetch messages older than this message id (keyset pagination). */
  before: z.string().max(64).optional(),
  after: z.string().max(64).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(LIMITS.MESSAGE_PAGE_SIZE_MAX)
    .default(LIMITS.MESSAGE_PAGE_SIZE),
});

/** A single emoji or short shortcode. Kept tight to avoid unbounded reaction keys. */
export const reactionSchema = z.object({
  emoji: z.string().trim().min(1).max(16),
});

export const createRoleSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.ROLE_NAME_MAX),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a hex value like #5865f2')
    .default('#99aab5'),
  permissions: z.number().int().min(0).default(0),
  hoist: z.boolean().default(false),
  mentionable: z.boolean().default(false),
});

export const updateRoleSchema = createRoleSchema.partial().extend({
  position: z.number().int().min(0).max(1000).optional(),
});

export const updateMemberSchema = z.object({
  nickname: z.string().trim().max(LIMITS.NICKNAME_MAX).nullable().optional(),
  roleIds: z.array(z.string().min(1).max(64)).max(LIMITS.MAX_ROLES_PER_SERVER).optional(),
});

export const createInviteSchema = z.object({
  maxUses: z.number().int().min(1).max(1000).nullable().optional(),
  /** Lifetime in seconds. null means the invite never expires. */
  expiresIn: z.number().int().min(60).max(60 * 60 * 24 * 30).nullable().optional(),
});

export const friendRequestSchema = z.object({
  /** Either "name#0001" or a bare username. */
  username: z.string().trim().min(1).max(LIMITS.USERNAME_MAX + 6),
});

export const searchSchema = z.object({
  q: z.string().trim().min(LIMITS.SEARCH_QUERY_MIN).max(LIMITS.SEARCH_QUERY_MAX),
  serverId: z.string().max(64).optional(),
  channelId: z.string().max(64).optional(),
  authorId: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  offset: z.coerce.number().int().min(0).max(1000).default(0),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type CreateServerInput = z.infer<typeof createServerSchema>;
export type CreateChannelInput = z.infer<typeof createChannelSchema>;
export type CreateMessageInput = z.infer<typeof createMessageSchema>;
export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type SearchInput = z.infer<typeof searchSchema>;
