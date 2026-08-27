/**
 * Notification and unread-state maintenance.
 *
 * Unread *dots* are derived on read: because message ids sort chronologically,
 * "this channel has new messages" is `channel.lastMessageId > readState.lastReadMessageId`,
 * which needs no bookkeeping at write time.
 *
 * Mention *badges* are different -- a count cannot be derived without scanning -- so this
 * module increments a per-user counter when a message pings someone, and clears it when
 * they acknowledge the channel.
 */

import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { NotificationPayload } from '@rockscord/shared';
import type { AppContext } from '../context.js';
import type { Database } from '../db/index.js';
import {
  dmParticipants,
  memberRoles,
  members,
  notifications,
  readStates,
} from '../db/schema.js';
import { emitToUser } from './emit.js';
import { newId } from './ids.js';

/** Persist a notification and push it to the user's connected clients. */
export async function createNotification(
  ctx: AppContext,
  db: Database,
  input: {
    userId: string;
    type: NotificationPayload['type'];
    title: string;
    body?: string;
    serverId?: string | null;
    channelId?: string | null;
    messageId?: string | null;
  },
): Promise<void> {
  const id = newId();
  const createdAt = Date.now();

  await db.insert(notifications).values({
    id,
    userId: input.userId,
    type: input.type,
    title: input.title.slice(0, 200),
    body: (input.body ?? '').slice(0, 500),
    serverId: input.serverId ?? null,
    channelId: input.channelId ?? null,
    messageId: input.messageId ?? null,
    createdAt,
  });

  emitToUser(ctx, input.userId, 'notification', {
    id,
    type: input.type,
    title: input.title.slice(0, 200),
    body: (input.body ?? '').slice(0, 500),
    serverId: input.serverId ?? null,
    channelId: input.channelId ?? null,
    messageId: input.messageId ?? null,
    createdAt,
  });
}

/**
 * Work out who should be pinged by a message.
 *
 * Returns user ids, already filtered so that:
 *  - the author never pings themselves,
 *  - only people who can actually be in the channel are included,
 *  - role mentions are expanded to their members,
 *  - @everyone expands to the whole server (the caller must have checked the permission).
 */
export async function resolveMentionTargets(
  db: Database,
  opts: {
    authorId: string;
    serverId: string | null;
    channelId: string;
    userIds: string[];
    roleIds: string[];
    everyone: boolean;
    /** Ids allowed to be pinged in this channel, when visibility is restricted. */
    audience?: Set<string>;
  },
): Promise<string[]> {
  const targets = new Set<string>();

  if (opts.serverId) {
    if (opts.everyone) {
      const rows = await db
        .select({ userId: members.userId })
        .from(members)
        .where(and(eq(members.serverId, opts.serverId), ne(members.userId, opts.authorId)));
      for (const row of rows) targets.add(row.userId);
    }

    if (opts.roleIds.length > 0) {
      const rows = await db
        .select({ userId: memberRoles.userId })
        .from(memberRoles)
        .where(
          and(
            eq(memberRoles.serverId, opts.serverId),
            inArray(memberRoles.roleId, opts.roleIds),
          ),
        );
      for (const row of rows) targets.add(row.userId);
    }

    if (opts.userIds.length > 0) {
      // Only actual members can be mentioned -- a crafted `<@id>` for a stranger must not
      // create a notification for someone who cannot even see the server.
      const rows = await db
        .select({ userId: members.userId })
        .from(members)
        .where(
          and(eq(members.serverId, opts.serverId), inArray(members.userId, opts.userIds)),
        );
      for (const row of rows) targets.add(row.userId);
    }
  } else {
    // DM: the only valid mention targets are the other participants.
    const rows = await db
      .select({ userId: dmParticipants.userId })
      .from(dmParticipants)
      .where(eq(dmParticipants.channelId, opts.channelId));
    for (const row of rows) {
      if (opts.userIds.includes(row.userId)) targets.add(row.userId);
    }
  }

  targets.delete(opts.authorId);

  if (opts.audience) {
    for (const id of [...targets]) {
      if (!opts.audience.has(id)) targets.delete(id);
    }
  }

  return [...targets];
}

/** Increment the mention badge for each pinged user. */
export async function bumpMentionCounts(
  db: Database,
  channelId: string,
  userIds: readonly string[],
): Promise<void> {
  for (const userId of userIds) {
    await db
      .insert(readStates)
      .values({ userId, channelId, mentionCount: 1, updatedAt: Date.now() })
      .onConflictDoUpdate({
        target: [readStates.userId, readStates.channelId],
        set: {
          mentionCount: sql`${readStates.mentionCount} + 1`,
          updatedAt: Date.now(),
        },
      });
  }
}

/** Mark a channel read up to `messageId` and clear its mention badge. */
export async function acknowledgeChannel(
  db: Database,
  userId: string,
  channelId: string,
  messageId: string,
): Promise<void> {
  await db
    .insert(readStates)
    .values({
      userId,
      channelId,
      lastReadMessageId: messageId,
      mentionCount: 0,
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: [readStates.userId, readStates.channelId],
      set: { lastReadMessageId: messageId, mentionCount: 0, updatedAt: Date.now() },
    });
}

/** True when the user has muted this channel and should get no notification. */
export async function isChannelMuted(
  db: Database,
  userId: string,
  channelId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ muted: readStates.muted })
    .from(readStates)
    .where(and(eq(readStates.userId, userId), eq(readStates.channelId, channelId)))
    .limit(1);
  return row?.muted ?? false;
}
