/**
 * Message routes. Mounted under `/api/channels`, so paths read as
 * `/api/channels/:channelId/messages`.
 *
 *   GET    /:channelId/messages                          paginated history
 *   POST   /:channelId/messages                          send
 *   PATCH  /:channelId/messages/:messageId               edit (author only)
 *   DELETE /:channelId/messages/:messageId               delete (author or MANAGE_MESSAGES)
 *   PUT    /:channelId/messages/:messageId/reactions/:e  react
 *   DELETE /:channelId/messages/:messageId/reactions/:e  un-react
 *   PUT    /:channelId/messages/:messageId/pin           pin
 *   DELETE /:channelId/messages/:messageId/pin           unpin
 *   GET    /:channelId/pins                              pinned messages
 *   POST   /:channelId/ack                               mark read
 *
 * Pagination is keyset, not offset: `?before=<messageId>` walks backwards through the
 * primary key. Offset pagination would re-scan the whole channel for every page and
 * would also skip or duplicate messages whenever someone posts mid-scroll.
 */

import { and, asc, desc, eq, gt, gte, inArray, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  LIMITS,
  Permission,
  createMessageSchema,
  editMessageSchema,
  listMessagesSchema,
  parseMentions,
  reactionSchema,
} from '@rockscord/shared';
import {
  attachments,
  channels,
  dmParticipants,
  members,
  messageMentions,
  messages,
  reactions,
} from '../db/schema.js';
import { ApiError, fromZodError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import {
  assertChannelPermission,
  getChannelPermissionContext,
  membersWhoCanViewChannel,
} from '../lib/permissions.js';
import { sanitizeMessageContent } from '../lib/sanitize.js';
import { hydrateMessage, hydrateMessages } from '../lib/serializers.js';
import { emitToChannel, emitToUsers,
  emitToChannelExcept,
  emitToUser,
} from '../lib/emit.js';
import {
  acknowledgeChannel,
  bumpMentionCounts,
  createNotification,
  isChannelMuted,
  resolveMentionTargets,
} from '../lib/notifications.js';
import type { Database } from '../db/index.js';

/**
 * Everyone who should receive realtime events for a channel.
 *
 * For a server channel this is the members who can actually *view* it -- not simply every
 * member. These events are delivered to personal rooms (so sidebars light up even when
 * the channel is not open), which would otherwise deliver private-channel content to
 * people who cannot open that channel.
 *
 * For a DM it is the conversation's participants.
 */
async function channelAudience(
  db: Database,
  channelId: string,
  serverId: string | null,
): Promise<string[]> {
  if (serverId) {
    return membersWhoCanViewChannel(db, serverId, channelId);
  }
  const rows = await db
    .select({ userId: dmParticipants.userId })
    .from(dmParticipants)
    .where(eq(dmParticipants.channelId, channelId));
  return rows.map((r) => r.userId);
}

export default async function messageRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const { db } = ctx;

  app.addHook('preHandler', app.authenticate);

  /* -------------------------------------------------------------------- */
  /* History                                                               */
  /* -------------------------------------------------------------------- */

  app.get('/:channelId/messages', async (request) => {
    const { channelId } = request.params as { channelId: string };
    const parsed = listMessagesSchema.safeParse(request.query);
    if (!parsed.success) throw fromZodError(parsed.error);

    const context = await getChannelPermissionContext(db, channelId, request.user!.id);
    assertChannelPermission(context, Permission.VIEW_CHANNEL, 'view this channel');
    assertChannelPermission(
      context,
      Permission.READ_MESSAGE_HISTORY,
      'read message history here',
    );

    const { before, after, around, limit } = parsed.data;

    let ordered: (typeof messages.$inferSelect)[];
    let hasMore: boolean;

    if (around) {
      /*
       * A window centred on one message, for jumping to a search hit or a reply.
       *
       * Two queries rather than one because the halves run in opposite directions: ids
       * are ULIDs, so "older" and "newer" are just `<` and `>` on the same ordering.
       * `hasMore` reports the older side, which is the direction the client scrolls.
       */
      const half = Math.max(1, Math.floor(limit / 2));

      const older = await db
        .select()
        .from(messages)
        .where(and(eq(messages.channelId, channelId), lt(messages.id, around)))
        .orderBy(desc(messages.id))
        .limit(half + 1);

      const newer = await db
        .select()
        .from(messages)
        .where(and(eq(messages.channelId, channelId), gte(messages.id, around)))
        .orderBy(asc(messages.id))
        .limit(half + 1);

      hasMore = older.length > half;
      ordered = [...(hasMore ? older.slice(0, half) : older)].reverse().concat(
        newer.length > half ? newer.slice(0, half) : newer,
      );
    } else {
      const conditions = [eq(messages.channelId, channelId)];
      if (before) conditions.push(lt(messages.id, before));
      if (after) conditions.push(gt(messages.id, after));

      // One extra row tells us whether another page exists without a second COUNT query.
      const rows = await db
        .select()
        .from(messages)
        .where(and(...conditions))
        .orderBy(after ? asc(messages.id) : desc(messages.id))
        .limit(limit + 1);

      hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;

      // Always hand the client oldest-first so it can append without re-sorting.
      ordered = after ? page : [...page].reverse();
    }
    const hydrated = await hydrateMessages(db, ordered, request.user!.id);

    return {
      messages: hydrated,
      hasMore,
      nextCursor: hasMore ? (ordered[0]?.id ?? null) : null,
    };
  });

  /* -------------------------------------------------------------------- */
  /* Send                                                                  */
  /* -------------------------------------------------------------------- */

  app.post(
    '/:channelId/messages',
    { config: { rateLimit: { max: 30, timeWindow: '10 seconds' } } },
    async (request, reply) => {
      const { channelId } = request.params as { channelId: string };
      const parsed = createMessageSchema.safeParse(request.body ?? {});
      if (!parsed.success) throw fromZodError(parsed.error);

      const userId = request.user!.id;
      const context = await getChannelPermissionContext(db, channelId, userId);
      assertChannelPermission(context, Permission.VIEW_CHANNEL, 'view this channel');
      assertChannelPermission(context, Permission.SEND_MESSAGES, 'send messages here');

      const [channel] = await db
        .select()
        .from(channels)
        .where(eq(channels.id, channelId))
        .limit(1);
      if (!channel) throw ApiError.notFound('Channel not found');
      if (channel.type === 'voice') {
        throw ApiError.badRequest('Voice channels do not accept text messages');
      }

      const content = sanitizeMessageContent(parsed.data.content ?? '');
      const attachmentIds = parsed.data.attachmentIds ?? [];

      if (!content && attachmentIds.length === 0) {
        throw ApiError.badRequest('A message needs text or an attachment');
      }

      if (attachmentIds.length > 0) {
        assertChannelPermission(context, Permission.ATTACH_FILES, 'upload files here');
      }

      // A reply must point at a message in this same channel, or the preview would leak
      // content from a channel the reader may not be able to see.
      let replyToId: string | null = null;
      if (parsed.data.replyToId) {
        const [target] = await db
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(eq(messages.id, parsed.data.replyToId), eq(messages.channelId, channelId)),
          )
          .limit(1);
        if (!target) throw ApiError.badRequest('You can only reply to a message in this channel');
        replyToId = target.id;
      }

      const mentions = parseMentions(content);
      const mentionsEveryone =
        mentions.everyone &&
        Boolean(context.serverId) &&
        (context.channelPermissions & Permission.MENTION_EVERYONE) !== 0;

      const messageId = newId();
      const createdAt = Date.now();

      const mentionTargets = await resolveMentionTargets(db, {
        authorId: userId,
        serverId: channel.serverId,
        channelId,
        userIds: mentions.userIds,
        roleIds: mentions.roleIds,
        everyone: mentionsEveryone,
      });

      await db.transaction(async (tx) => {
        await tx.insert(messages).values({
          id: messageId,
          channelId,
          authorId: userId,
          content,
          replyToId,
          mentionsEveryone,
          createdAt,
        });

        if (attachmentIds.length > 0) {
          // Claiming attachments is scoped to the uploader and to still-unattached rows,
          // so one user cannot attach someone else's upload to their own message.
          const claimed = await tx
            .update(attachments)
            .set({ messageId })
            .where(
              and(
                inArray(attachments.id, attachmentIds),
                eq(attachments.uploaderId, userId),
                sql`${attachments.messageId} is null`,
              ),
            )
            .returning({ id: attachments.id });

          if (claimed.length !== attachmentIds.length) {
            throw ApiError.badRequest('One or more attachments are invalid or already used');
          }
        }

        if (mentionTargets.length > 0) {
          await tx
            .insert(messageMentions)
            .values(mentionTargets.map((mentionedId) => ({ messageId, userId: mentionedId })))
            .onConflictDoNothing();
        }

        await tx
          .update(channels)
          .set({ lastMessageAt: createdAt })
          .where(eq(channels.id, channelId));
      });

      const [row] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
      const message = await hydrateMessage(db, row!, userId);

      /*
       * The author's copy carries their nonce so their client can swap its optimistic
       * placeholder for the real message in one step. Everyone else gets the message
       * plain: the token means nothing to them, and it is the sender's to correlate.
       */
      emitToChannelExcept(ctx, channelId, userId, 'message:create', message);
      emitToUser(ctx, userId, 'message:create', {
        ...message,
        ...(parsed.data.nonce ? { nonce: parsed.data.nonce } : {}),
      });

      /*
       * Socket rooms only contain people with the channel *open*. Anyone else still needs
       * the event so their sidebar shows an unread dot, so the message is also pushed to
       * every member's personal room. Clients de-duplicate by message id.
       */
      const audience = await channelAudience(db, channelId, channel.serverId);
      emitToUsers(
        ctx,
        audience.filter((id) => id !== userId),
        'message:create',
        message,
      );

      if (mentionTargets.length > 0) {
        await bumpMentionCounts(db, channelId, mentionTargets);
      }

      // The sender has by definition read their own message.
      await acknowledgeChannel(db, userId, channelId, messageId);

      const preview = content.slice(0, 140) || 'Sent an attachment';
      const authorName = request.user!.displayName;

      for (const targetId of mentionTargets) {
        if (await isChannelMuted(db, targetId, channelId)) continue;
        await createNotification(ctx, db, {
          userId: targetId,
          type: 'mention',
          title: `${authorName} mentioned you`,
          body: preview,
          serverId: channel.serverId,
          channelId,
          messageId,
        });
      }

      if (!channel.serverId) {
        // A DM is itself a notification, whether or not it contains a mention.
        for (const participantId of audience) {
          if (participantId === userId) continue;
          if (mentionTargets.includes(participantId)) continue;
          if (await isChannelMuted(db, participantId, channelId)) continue;
          await createNotification(ctx, db, {
            userId: participantId,
            type: 'dm',
            title: authorName,
            body: preview,
            channelId,
            messageId,
          });
        }
      }

      return reply.status(201).send({ message, nonce: parsed.data.nonce ?? null });
    },
  );

  /* -------------------------------------------------------------------- */
  /* Edit & delete                                                         */
  /* -------------------------------------------------------------------- */

  app.patch('/:channelId/messages/:messageId', async (request) => {
    const { channelId, messageId } = request.params as {
      channelId: string;
      messageId: string;
    };
    const parsed = editMessageSchema.safeParse(request.body);
    if (!parsed.success) throw fromZodError(parsed.error);

    const userId = request.user!.id;
    const context = await getChannelPermissionContext(db, channelId, userId);
    assertChannelPermission(context, Permission.VIEW_CHANNEL, 'view this channel');

    const [existing] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.channelId, channelId)))
      .limit(1);

    if (!existing || existing.deleted) throw ApiError.notFound('Message not found');

    // Editing is author-only, always. MANAGE_MESSAGES allows deletion, not rewriting
    // what somebody else said.
    if (existing.authorId !== userId) {
      throw ApiError.missingPermissions('You can only edit your own messages');
    }

    const content = sanitizeMessageContent(parsed.data.content);
    if (!content) throw ApiError.badRequest('A message cannot be empty');

    const mentions = parseMentions(content);
    const mentionsEveryone =
      mentions.everyone &&
      Boolean(context.serverId) &&
      (context.channelPermissions & Permission.MENTION_EVERYONE) !== 0;

    const [channel] = await db
      .select({ serverId: channels.serverId })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);

    const mentionTargets = await resolveMentionTargets(db, {
      authorId: userId,
      serverId: channel?.serverId ?? null,
      channelId,
      userIds: mentions.userIds,
      roleIds: mentions.roleIds,
      everyone: mentionsEveryone,
    });

    await db.transaction(async (tx) => {
      await tx
        .update(messages)
        .set({ content, editedAt: Date.now(), mentionsEveryone })
        .where(eq(messages.id, messageId));

      await tx.delete(messageMentions).where(eq(messageMentions.messageId, messageId));
      if (mentionTargets.length > 0) {
        await tx
          .insert(messageMentions)
          .values(mentionTargets.map((id) => ({ messageId, userId: id })))
          .onConflictDoNothing();
      }
    });

    const [row] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
    const message = await hydrateMessage(db, row!, userId);

    emitToChannel(ctx, channelId, 'message:update', { message });
    return { message };
  });

  app.delete('/:channelId/messages/:messageId', async (request) => {
    const { channelId, messageId } = request.params as {
      channelId: string;
      messageId: string;
    };

    const userId = request.user!.id;
    const context = await getChannelPermissionContext(db, channelId, userId);
    assertChannelPermission(context, Permission.VIEW_CHANNEL, 'view this channel');

    const [existing] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.channelId, channelId)))
      .limit(1);

    if (!existing || existing.deleted) throw ApiError.notFound('Message not found');

    const isAuthor = existing.authorId === userId;
    if (!isAuthor) {
      assertChannelPermission(
        context,
        Permission.MANAGE_MESSAGES,
        "delete other people's messages",
      );
    }

    // Tombstone rather than DELETE: replies pointing here must still render, and the
    // FTS index is cleared by blanking the content.
    await db
      .update(messages)
      .set({ deleted: true, content: '', pinned: false, editedAt: Date.now() })
      .where(eq(messages.id, messageId));

    await db.delete(attachments).where(eq(attachments.messageId, messageId));
    await db.delete(reactions).where(eq(reactions.messageId, messageId));
    await db.delete(messageMentions).where(eq(messageMentions.messageId, messageId));

    emitToChannel(ctx, channelId, 'message:delete', { channelId, messageId });

    const [channel] = await db
      .select({ serverId: channels.serverId })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);
    const audience = await channelAudience(db, channelId, channel?.serverId ?? null);
    emitToUsers(ctx, audience, 'message:delete', { channelId, messageId });

    return { ok: true };
  });

  /* -------------------------------------------------------------------- */
  /* Reactions                                                             */
  /* -------------------------------------------------------------------- */

  app.put('/:channelId/messages/:messageId/reactions/:emoji', async (request) => {
    const { channelId, messageId, emoji: rawEmoji } = request.params as {
      channelId: string;
      messageId: string;
      emoji: string;
    };

    const parsed = reactionSchema.safeParse({ emoji: decodeURIComponent(rawEmoji) });
    if (!parsed.success) throw fromZodError(parsed.error);

    const userId = request.user!.id;
    const context = await getChannelPermissionContext(db, channelId, userId);
    assertChannelPermission(context, Permission.ADD_REACTIONS, 'react to messages here');

    const [existing] = await db
      .select({ id: messages.id, deleted: messages.deleted })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.channelId, channelId)))
      .limit(1);
    if (!existing || existing.deleted) throw ApiError.notFound('Message not found');

    await db
      .insert(reactions)
      .values({ messageId, userId, emoji: parsed.data.emoji })
      .onConflictDoNothing();

    const payload = { channelId, messageId, emoji: parsed.data.emoji, userId };
    emitToChannel(ctx, channelId, 'message:reaction:add', payload);
    return { ok: true };
  });

  app.delete('/:channelId/messages/:messageId/reactions/:emoji', async (request) => {
    const { channelId, messageId, emoji: rawEmoji } = request.params as {
      channelId: string;
      messageId: string;
      emoji: string;
    };

    const emoji = decodeURIComponent(rawEmoji);
    const userId = request.user!.id;
    await getChannelPermissionContext(db, channelId, userId);

    await db
      .delete(reactions)
      .where(
        and(
          eq(reactions.messageId, messageId),
          eq(reactions.userId, userId),
          eq(reactions.emoji, emoji),
        ),
      );

    emitToChannel(ctx, channelId, 'message:reaction:remove', {
      channelId,
      messageId,
      emoji,
      userId,
    });
    return { ok: true };
  });

  /* -------------------------------------------------------------------- */
  /* Pins                                                                  */
  /* -------------------------------------------------------------------- */

  app.put('/:channelId/messages/:messageId/pin', async (request) => {
    const { channelId, messageId } = request.params as {
      channelId: string;
      messageId: string;
    };

    const context = await getChannelPermissionContext(db, channelId, request.user!.id);
    assertChannelPermission(context, Permission.MANAGE_MESSAGES, 'pin messages here');

    await db
      .update(messages)
      .set({ pinned: true })
      .where(and(eq(messages.id, messageId), eq(messages.channelId, channelId)));

    const [row] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
    if (!row) throw ApiError.notFound('Message not found');

    const message = await hydrateMessage(db, row, request.user!.id);
    emitToChannel(ctx, channelId, 'message:update', { message });
    return { message };
  });

  app.delete('/:channelId/messages/:messageId/pin', async (request) => {
    const { channelId, messageId } = request.params as {
      channelId: string;
      messageId: string;
    };

    const context = await getChannelPermissionContext(db, channelId, request.user!.id);
    assertChannelPermission(context, Permission.MANAGE_MESSAGES, 'unpin messages here');

    await db
      .update(messages)
      .set({ pinned: false })
      .where(and(eq(messages.id, messageId), eq(messages.channelId, channelId)));

    const [row] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
    if (!row) throw ApiError.notFound('Message not found');

    const message = await hydrateMessage(db, row, request.user!.id);
    emitToChannel(ctx, channelId, 'message:update', { message });
    return { message };
  });

  app.get('/:channelId/pins', async (request) => {
    const { channelId } = request.params as { channelId: string };
    const context = await getChannelPermissionContext(db, channelId, request.user!.id);
    assertChannelPermission(context, Permission.VIEW_CHANNEL, 'view this channel');

    const rows = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.channelId, channelId),
          eq(messages.pinned, true),
          eq(messages.deleted, false),
        ),
      )
      .orderBy(desc(messages.id))
      .limit(50);

    return { messages: await hydrateMessages(db, rows, request.user!.id) };
  });

  /* -------------------------------------------------------------------- */
  /* Read acknowledgement                                                  */
  /* -------------------------------------------------------------------- */

  app.post('/:channelId/ack', async (request) => {
    const { channelId } = request.params as { channelId: string };
    const { messageId } = (request.body ?? {}) as { messageId?: string };
    if (!messageId) throw ApiError.badRequest('messageId is required');

    await getChannelPermissionContext(db, channelId, request.user!.id);
    await acknowledgeChannel(db, request.user!.id, channelId, messageId);

    return { ok: true };
  });

  /* -------------------------------------------------------------------- */
  /* Typing (HTTP fallback for clients without a live socket)              */
  /* -------------------------------------------------------------------- */

  app.post(
    '/:channelId/typing',
    { config: { rateLimit: { max: 20, timeWindow: '10 seconds' } } },
    async (request) => {
      const { channelId } = request.params as { channelId: string };
      const context = await getChannelPermissionContext(db, channelId, request.user!.id);
      assertChannelPermission(context, Permission.SEND_MESSAGES, 'type here');

      emitToChannel(ctx, channelId, 'typing:start', {
        channelId,
        userId: request.user!.id,
        username: request.user!.displayName,
      });

      return { ok: true };
    },
  );
}
