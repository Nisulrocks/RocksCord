/**
 * Channel routes.
 *
 *   GET    /api/channels/server/:serverId       channels the caller can see
 *   POST   /api/channels/server/:serverId       create a text or voice channel
 *   GET    /api/channels/:channelId             detail (+ overwrites)
 *   PATCH  /api/channels/:channelId             rename / topic / reorder
 *   DELETE /api/channels/:channelId             delete
 *   PUT    /api/channels/:channelId/permissions upsert a permission overwrite
 *   DELETE /api/channels/:channelId/permissions/:targetType/:targetId  remove one
 *
 * Note that channel *visibility* is enforced on read, not just on write: a channel the
 * caller cannot VIEW is omitted from the list entirely and 404s on direct access, so a
 * private channel's existence is not observable.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  LIMITS,
  Permission,
  channelOverwriteSchema,
  createChannelSchema,
  updateChannelSchema,
} from '@rockscord/shared';
import { channelOverwrites, channels, roles } from '../db/schema.js';
import { ApiError, fromZodError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import {
  assertChannelPermission,
  assertPermission,
  filterVisibleChannels,
  getChannelPermissionContext,
  requireMember,
} from '../lib/permissions.js';
import { sanitizeChannelName } from '../lib/sanitize.js';
import { loadOverwrites, toChannel } from '../lib/serializers.js';
import { emitToServer, writeAuditLog } from '../lib/emit.js';

export default async function channelRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const { db } = ctx;

  app.addHook('preHandler', app.authenticate);

  /* -------------------------------------------------------------------- */
  /* List & create                                                         */
  /* -------------------------------------------------------------------- */

  app.get('/server/:serverId', async (request) => {
    const { serverId } = request.params as { serverId: string };
    const context = await requireMember(db, serverId, request.user!.id);

    const rows = await db
      .select()
      .from(channels)
      .where(eq(channels.serverId, serverId))
      .orderBy(asc(channels.position), asc(channels.id));

    const visible = await filterVisibleChannels(
      db,
      context,
      rows.map((r) => r.id),
    );

    return { channels: rows.filter((r) => visible.has(r.id)).map((r) => toChannel(r)) };
  });

  app.post('/server/:serverId', async (request, reply) => {
    const { serverId } = request.params as { serverId: string };
    const parsed = createChannelSchema.safeParse(request.body);
    if (!parsed.success) throw fromZodError(parsed.error);

    const context = await requireMember(db, serverId, request.user!.id);
    assertPermission(context, Permission.MANAGE_CHANNELS, 'create channels');

    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(channels)
      .where(eq(channels.serverId, serverId));
    const count = Number(countRow?.count ?? 0);

    if (count >= LIMITS.MAX_CHANNELS_PER_SERVER) {
      throw ApiError.badRequest(
        `A server can have at most ${LIMITS.MAX_CHANNELS_PER_SERVER} channels`,
      );
    }

    // Text channels get slugified (#my-channel); voice channels keep natural casing.
    const isVoice = parsed.data.type === 'voice';
    const name = sanitizeChannelName(parsed.data.name, !isVoice);
    if (!name) throw ApiError.badRequest('Channel name cannot be empty');

    const [maxPositionRow] = await db
      .select({ maxPosition: sql<number>`coalesce(max(${channels.position}), -1)` })
      .from(channels)
      .where(eq(channels.serverId, serverId));
    const maxPosition = Number(maxPositionRow?.maxPosition ?? -1);

    const channelId = newId();
    await db.insert(channels).values({
      id: channelId,
      serverId,
      name,
      type: isVoice ? 'voice' : 'text',
      topic: parsed.data.topic ?? null,
      position: maxPosition + 1,
    });

    const [row] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
    const channel = toChannel(row!);

    emitToServer(ctx, serverId, 'channel:create', channel);
    await writeAuditLog(db, {
      serverId,
      actorId: request.user!.id,
      action: 'channel.create',
      targetType: 'channel',
      targetId: channelId,
      metadata: { name, type: channel.type },
    });

    return reply.status(201).send({ channel });
  });

  /* -------------------------------------------------------------------- */
  /* Detail, update, delete                                                */
  /* -------------------------------------------------------------------- */

  app.get('/:channelId', async (request) => {
    const { channelId } = request.params as { channelId: string };
    const context = await getChannelPermissionContext(db, channelId, request.user!.id);
    assertChannelPermission(context, Permission.VIEW_CHANNEL, 'view this channel');

    const [row] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
    if (!row) throw ApiError.notFound('Channel not found');

    const overwriteMap = await loadOverwrites(db, [channelId]);

    return {
      channel: toChannel(row, overwriteMap.get(channelId) ?? []),
      permissions: context.channelPermissions,
    };
  });

  app.patch('/:channelId', async (request) => {
    const { channelId } = request.params as { channelId: string };
    const parsed = updateChannelSchema.safeParse(request.body);
    if (!parsed.success) throw fromZodError(parsed.error);

    const context = await getChannelPermissionContext(db, channelId, request.user!.id);
    assertChannelPermission(context, Permission.MANAGE_CHANNELS, 'edit this channel');

    const [existing] = await db
      .select()
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);
    if (!existing) throw ApiError.notFound('Channel not found');

    const patch: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) {
      const name = sanitizeChannelName(parsed.data.name, existing.type !== 'voice');
      if (!name) throw ApiError.badRequest('Channel name cannot be empty');
      patch.name = name;
    }
    if (parsed.data.topic !== undefined) patch.topic = parsed.data.topic;
    if (parsed.data.position !== undefined) patch.position = parsed.data.position;

    if (Object.keys(patch).length > 0) {
      await db.update(channels).set(patch).where(eq(channels.id, channelId));
    }

    const [row] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
    const channel = toChannel(row!);

    if (existing.serverId) {
      emitToServer(ctx, existing.serverId, 'channel:update', channel);
      await writeAuditLog(db, {
        serverId: existing.serverId,
        actorId: request.user!.id,
        action: 'channel.update',
        targetType: 'channel',
        targetId: channelId,
        metadata: patch,
      });
    }

    return { channel };
  });

  app.delete('/:channelId', async (request) => {
    const { channelId } = request.params as { channelId: string };

    const context = await getChannelPermissionContext(db, channelId, request.user!.id);
    assertChannelPermission(context, Permission.MANAGE_CHANNELS, 'delete this channel');

    const [existing] = await db
      .select()
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);
    if (!existing) throw ApiError.notFound('Channel not found');
    if (!existing.serverId) throw ApiError.badRequest('DM channels cannot be deleted');

    // Refuse to delete the last text channel: a server with nowhere to talk is a
    // support ticket waiting to happen, and it cannot be undone.
    if (existing.type === 'text') {
      const [countRow] = await db
        .select({ count: sql<number>`count(*)` })
        .from(channels)
        .where(and(eq(channels.serverId, existing.serverId), eq(channels.type, 'text')));
      const count = Number(countRow?.count ?? 0);
      if (count <= 1) {
        throw ApiError.badRequest('A server needs at least one text channel');
      }
    }

    await db.delete(channels).where(eq(channels.id, channelId));

    emitToServer(ctx, existing.serverId, 'channel:delete', {
      serverId: existing.serverId,
      channelId,
    });
    await writeAuditLog(db, {
      serverId: existing.serverId,
      actorId: request.user!.id,
      action: 'channel.delete',
      targetType: 'channel',
      targetId: channelId,
      metadata: { name: existing.name },
    });

    return { ok: true };
  });

  /* -------------------------------------------------------------------- */
  /* Permission overwrites                                                 */
  /* -------------------------------------------------------------------- */

  app.put('/:channelId/permissions', async (request) => {
    const { channelId } = request.params as { channelId: string };
    const parsed = channelOverwriteSchema.safeParse(request.body);
    if (!parsed.success) throw fromZodError(parsed.error);

    const context = await getChannelPermissionContext(db, channelId, request.user!.id);
    assertChannelPermission(context, Permission.MANAGE_ROLES, 'edit channel permissions');

    if (!context.serverId) {
      throw ApiError.badRequest('DM channels have no permission overwrites');
    }

    /*
     * You may only grant or deny permissions you hold yourself. Without this, a
     * moderator with MANAGE_ROLES in one channel could mint an overwrite granting
     * themselves BAN_MEMBERS there.
     */
    const escalating = (parsed.data.allow | parsed.data.deny) & ~context.permissions;
    if (!context.isOwner && escalating !== 0) {
      throw ApiError.missingPermissions(
        'You cannot set permissions that you do not have yourself',
      );
    }

    if (parsed.data.targetType === 'role') {
      const [role] = await db
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.id, parsed.data.targetId), eq(roles.serverId, context.serverId)))
        .limit(1);
      if (!role) throw ApiError.badRequest('That role is not part of this server');
    }

    await db
      .insert(channelOverwrites)
      .values({
        channelId,
        targetType: parsed.data.targetType,
        targetId: parsed.data.targetId,
        allow: parsed.data.allow,
        deny: parsed.data.deny,
      })
      .onConflictDoUpdate({
        target: [
          channelOverwrites.channelId,
          channelOverwrites.targetType,
          channelOverwrites.targetId,
        ],
        set: { allow: parsed.data.allow, deny: parsed.data.deny },
      });

    const [row] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
    const overwriteMap = await loadOverwrites(db, [channelId]);
    const channel = toChannel(row!, overwriteMap.get(channelId) ?? []);

    emitToServer(ctx, context.serverId, 'channel:update', channel);
    await writeAuditLog(db, {
      serverId: context.serverId,
      actorId: request.user!.id,
      action: 'channel.permissions.update',
      targetType: 'channel',
      targetId: channelId,
      metadata: parsed.data,
    });

    return { channel };
  });

  app.delete('/:channelId/permissions/:targetType/:targetId', async (request) => {
    const { channelId, targetType, targetId } = request.params as {
      channelId: string;
      targetType: 'role' | 'member';
      targetId: string;
    };

    if (targetType !== 'role' && targetType !== 'member') {
      throw ApiError.badRequest('targetType must be "role" or "member"');
    }

    const context = await getChannelPermissionContext(db, channelId, request.user!.id);
    assertChannelPermission(context, Permission.MANAGE_ROLES, 'edit channel permissions');

    await db
      .delete(channelOverwrites)
      .where(
        and(
          eq(channelOverwrites.channelId, channelId),
          eq(channelOverwrites.targetType, targetType),
          eq(channelOverwrites.targetId, targetId),
        ),
      );

    const [row] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
    const overwriteMap = await loadOverwrites(db, [channelId]);
    const channel = toChannel(row!, overwriteMap.get(channelId) ?? []);

    if (context.serverId) emitToServer(ctx, context.serverId, 'channel:update', channel);
    return { channel };
  });
}
