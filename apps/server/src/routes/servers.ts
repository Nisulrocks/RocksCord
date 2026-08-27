/**
 * Server (guild) routes.
 *
 *   GET    /api/servers                     servers the caller belongs to
 *   POST   /api/servers                     create one (with @everyone, roles, channels)
 *   GET    /api/servers/:id                 detail
 *   PATCH  /api/servers/:id                 rename / icon / description
 *   DELETE /api/servers/:id                 owner only, cascades everything
 *   GET    /api/servers/:id/members         member list with roles
 *   PATCH  /api/servers/:id/members/:userId nickname and role assignment
 *   DELETE /api/servers/:id/members/:userId kick
 *   POST   /api/servers/:id/bans/:userId    ban
 *   DELETE /api/servers/:id/bans/:userId    unban
 *   GET    /api/servers/:id/bans            ban list
 *   POST   /api/servers/:id/leave           leave (owner must transfer or delete)
 *   POST   /api/servers/:id/transfer        hand ownership to another member
 *   GET    /api/servers/:id/audit-log       moderation history
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  ADMIN_PERMISSIONS,
  DEFAULT_EVERYONE_PERMISSIONS,
  LIMITS,
  MODERATOR_PERMISSIONS,
  Permission,
  Rooms,
  createServerSchema,
  updateMemberSchema,
  updateServerSchema,
} from '@rockscord/shared';
import {
  auditLogs,
  bans,
  channels,
  memberRoles,
  members,
  roles,
  servers,
  users,
} from '../db/schema.js';
import { ApiError, fromZodError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import {
  assertHigherThan,
  assertPermission,
  getMemberContext,
  requireMember,
} from '../lib/permissions.js';
import { sanitizeDisplayName } from '../lib/sanitize.js';
import {
  loadMemberRoleIds,
  loadUsers,
  publicUserColumns,
  toMember,
  toRole,
  toServer,
} from '../lib/serializers.js';
import {
  emitToServer,
  emitToUser,
  moveUserSockets,
  writeAuditLog,
} from '../lib/emit.js';
import type { Database } from '../db/index.js';

/** Member counts for a batch of servers, in one grouped query. */
async function memberCounts(
  db: Database,
  serverIds: string[],
): Promise<Map<string, number>> {
  if (serverIds.length === 0) return new Map();
  const rows = await db
    .select({ serverId: members.serverId, count: sql<number>`count(*)` })
    .from(members)
    .where(inArray(members.serverId, serverIds))
    .groupBy(members.serverId);
  return new Map(rows.map((r) => [r.serverId, Number(r.count)]));
}

export default async function serverRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const { db } = ctx;

  app.addHook('preHandler', app.authenticate);

  /* -------------------------------------------------------------------- */
  /* List & create                                                         */
  /* -------------------------------------------------------------------- */

  app.get('/', async (request) => {
    const rows = await db
      .select({ server: servers })
      .from(members)
      .innerJoin(servers, eq(servers.id, members.serverId))
      .where(eq(members.userId, request.user!.id));

    const counts = await memberCounts(
      db,
      rows.map((r) => r.server.id),
    );

    return {
      servers: rows.map((r) => toServer(r.server, counts.get(r.server.id) ?? 0)),
    };
  });

  app.post(
    '/',
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const parsed = createServerSchema.safeParse(request.body);
      if (!parsed.success) throw fromZodError(parsed.error);

      const userId = request.user!.id;

      const [countRow] = await db
        .select({ count: sql<number>`count(*)` })
        .from(members)
        .where(eq(members.userId, userId));
      const count = Number(countRow?.count ?? 0);

      if (count >= LIMITS.MAX_SERVERS_PER_USER) {
        throw ApiError.badRequest(
          `You can only be in ${LIMITS.MAX_SERVERS_PER_USER} servers at once`,
        );
      }

      const serverId = newId();
      const name = sanitizeDisplayName(parsed.data.name, LIMITS.SERVER_NAME_MAX);
      if (!name) throw ApiError.badRequest('Server name cannot be empty');

      /*
       * Everything below is one logical unit: a server without an @everyone role is
       * unusable (permission resolution throws on it), and a server with no channels has
       * nowhere to land after joining. libSQL runs this as a single transaction so a
       * failure halfway cannot leave a half-built server behind.
       */
      const everyoneRoleId = newId();
      const adminRoleId = newId();
      const moderatorRoleId = newId();
      const generalChannelId = newId();
      const voiceChannelId = newId();

      await db.transaction(async (tx) => {
        await tx.insert(servers).values({
          id: serverId,
          name,
          description: parsed.data.description ?? null,
          iconUrl: parsed.data.iconUrl ?? null,
          ownerId: userId,
        });

        await tx.insert(roles).values([
          {
            id: everyoneRoleId,
            serverId,
            name: '@everyone',
            color: '#99aab5',
            permissions: DEFAULT_EVERYONE_PERMISSIONS,
            position: 0,
            isDefault: true,
          },
          {
            id: moderatorRoleId,
            serverId,
            name: 'Moderator',
            color: '#3ba55d',
            permissions: MODERATOR_PERMISSIONS,
            position: 1,
            hoist: true,
          },
          {
            id: adminRoleId,
            serverId,
            name: 'Admin',
            color: '#f0b232',
            permissions: ADMIN_PERMISSIONS,
            position: 2,
            hoist: true,
          },
        ]);

        await tx.insert(channels).values([
          { id: generalChannelId, serverId, name: 'general', type: 'text', position: 0 },
          { id: voiceChannelId, serverId, name: 'General Voice', type: 'voice', position: 1 },
        ]);

        await tx.insert(members).values({ serverId, userId });
      });

      const [created] = await db
        .select()
        .from(servers)
        .where(eq(servers.id, serverId))
        .limit(1);

      const server = toServer(created!, 1);

      // The creator's other open tabs need to learn about the new server too.
      await moveUserSockets(ctx, userId, Rooms.server(serverId), 'join');
      emitToUser(ctx, userId, 'server:create', server);

      await writeAuditLog(db, {
        serverId,
        actorId: userId,
        action: 'server.create',
        targetType: 'server',
        targetId: serverId,
        metadata: { name },
      });

      request.log.info({ serverId, userId, name }, 'server created');
      return reply.status(201).send({ server });
    },
  );

  /* -------------------------------------------------------------------- */
  /* Detail & settings                                                     */
  /* -------------------------------------------------------------------- */

  app.get('/:serverId', async (request) => {
    const { serverId } = request.params as { serverId: string };
    await requireMember(db, serverId, request.user!.id);

    const [row] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
    if (!row) throw ApiError.notFound('Server not found');

    const counts = await memberCounts(db, [serverId]);
    const roleRows = await db
      .select()
      .from(roles)
      .where(eq(roles.serverId, serverId))
      .orderBy(desc(roles.position));

    return {
      server: toServer(row, counts.get(serverId) ?? 0),
      roles: roleRows.map(toRole),
    };
  });

  app.patch('/:serverId', async (request) => {
    const { serverId } = request.params as { serverId: string };
    const parsed = updateServerSchema.safeParse(request.body);
    if (!parsed.success) throw fromZodError(parsed.error);

    const context = await requireMember(db, serverId, request.user!.id);
    assertPermission(context, Permission.MANAGE_SERVER, 'change server settings');

    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (parsed.data.name !== undefined) {
      const name = sanitizeDisplayName(parsed.data.name, LIMITS.SERVER_NAME_MAX);
      if (!name) throw ApiError.badRequest('Server name cannot be empty');
      patch.name = name;
    }
    if (parsed.data.description !== undefined) patch.description = parsed.data.description;
    if (parsed.data.iconUrl !== undefined) patch.iconUrl = parsed.data.iconUrl;

    await db.update(servers).set(patch).where(eq(servers.id, serverId));

    const [row] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
    const counts = await memberCounts(db, [serverId]);
    const server = toServer(row!, counts.get(serverId) ?? 0);

    emitToServer(ctx, serverId, 'server:update', server);
    await writeAuditLog(db, {
      serverId,
      actorId: request.user!.id,
      action: 'server.update',
      targetType: 'server',
      targetId: serverId,
      metadata: patch,
    });

    return { server };
  });

  app.delete('/:serverId', async (request) => {
    const { serverId } = request.params as { serverId: string };

    const [row] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
    if (!row) throw ApiError.notFound('Server not found');

    // Deleting is destructive and irreversible, so it is owner-only -- not even
    // ADMINISTRATOR is enough.
    if (row.ownerId !== request.user!.id) {
      throw ApiError.missingPermissions('Only the server owner can delete this server');
    }

    const memberRows = await db
      .select({ userId: members.userId })
      .from(members)
      .where(eq(members.serverId, serverId));

    // Every channel, role, message, and membership is removed by ON DELETE CASCADE.
    await db.delete(servers).where(eq(servers.id, serverId));

    emitToServer(ctx, serverId, 'server:delete', { serverId });
    for (const member of memberRows) {
      await moveUserSockets(ctx, member.userId, Rooms.server(serverId), 'leave');
    }

    request.log.info({ serverId, userId: request.user!.id }, 'server deleted');
    return { ok: true };
  });

  /* -------------------------------------------------------------------- */
  /* Members                                                               */
  /* -------------------------------------------------------------------- */

  app.get('/:serverId/members', async (request) => {
    const { serverId } = request.params as { serverId: string };
    await requireMember(db, serverId, request.user!.id);

    const rows = await db
      .select({ member: members, user: publicUserColumns })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(eq(members.serverId, serverId))
      .limit(1000);

    const roleMap = await loadMemberRoleIds(db, serverId);

    return {
      members: rows.map((row) =>
        toMember(row.member, row.user, roleMap.get(row.member.userId) ?? []),
      ),
    };
  });

  app.patch('/:serverId/members/:userId', async (request) => {
    const { serverId, userId } = request.params as { serverId: string; userId: string };
    const parsed = updateMemberSchema.safeParse(request.body);
    if (!parsed.success) throw fromZodError(parsed.error);

    const actor = await requireMember(db, serverId, request.user!.id);
    const target = await getMemberContext(db, serverId, userId);
    if (!target) throw ApiError.notFound('That person is not in this server');

    const isSelf = userId === request.user!.id;

    if (parsed.data.nickname !== undefined) {
      // Changing your own nickname needs no permission; changing someone else's does.
      if (!isSelf) {
        assertPermission(actor, Permission.MANAGE_NICKNAMES, 'change nicknames');
        assertHigherThan(actor, target, 'rename');
      }
      const nickname = parsed.data.nickname
        ? sanitizeDisplayName(parsed.data.nickname, LIMITS.NICKNAME_MAX)
        : null;
      await db
        .update(members)
        .set({ nickname })
        .where(and(eq(members.serverId, serverId), eq(members.userId, userId)));
    }

    if (parsed.data.roleIds !== undefined) {
      assertPermission(actor, Permission.MANAGE_ROLES, 'assign roles');
      assertHigherThan(actor, target, 'change the roles of');

      const serverRoles = await db
        .select({ id: roles.id, position: roles.position, isDefault: roles.isDefault })
        .from(roles)
        .where(eq(roles.serverId, serverId));

      const byId = new Map(serverRoles.map((r) => [r.id, r]));
      const requested = parsed.data.roleIds.filter((id) => {
        const role = byId.get(id);
        return role && !role.isDefault;
      });

      // You cannot grant a role at or above your own highest -- that is how a moderator
      // would otherwise promote themselves to admin.
      if (!actor.isOwner) {
        for (const roleId of requested) {
          const role = byId.get(roleId)!;
          if (role.position >= actor.highestRolePosition) {
            throw ApiError.missingPermissions(
              'You cannot assign a role equal to or higher than your own',
            );
          }
        }
      }

      await db.transaction(async (tx) => {
        await tx
          .delete(memberRoles)
          .where(and(eq(memberRoles.serverId, serverId), eq(memberRoles.userId, userId)));
        if (requested.length > 0) {
          await tx
            .insert(memberRoles)
            .values(requested.map((roleId) => ({ serverId, userId, roleId })));
        }
      });

      await writeAuditLog(db, {
        serverId,
        actorId: request.user!.id,
        action: 'member.roles.update',
        targetType: 'user',
        targetId: userId,
        metadata: { roleIds: requested },
      });
    }

    const [memberRow] = await db
      .select({ member: members, user: publicUserColumns })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(and(eq(members.serverId, serverId), eq(members.userId, userId)))
      .limit(1);

    const roleMap = await loadMemberRoleIds(db, serverId);
    const member = toMember(
      memberRow!.member,
      memberRow!.user,
      roleMap.get(userId) ?? [],
    );

    emitToServer(ctx, serverId, 'member:update', member);
    return { member };
  });

  app.delete('/:serverId/members/:userId', async (request) => {
    const { serverId, userId } = request.params as { serverId: string; userId: string };

    const actor = await requireMember(db, serverId, request.user!.id);
    assertPermission(actor, Permission.KICK_MEMBERS, 'kick members');

    const target = await getMemberContext(db, serverId, userId);
    if (!target) throw ApiError.notFound('That person is not in this server');
    assertHigherThan(actor, target, 'kick');

    await db
      .delete(members)
      .where(and(eq(members.serverId, serverId), eq(members.userId, userId)));

    emitToServer(ctx, serverId, 'member:leave', { serverId, userId });
    emitToUser(ctx, userId, 'server:delete', { serverId });
    await moveUserSockets(ctx, userId, Rooms.server(serverId), 'leave');

    await writeAuditLog(db, {
      serverId,
      actorId: request.user!.id,
      action: 'member.kick',
      targetType: 'user',
      targetId: userId,
    });

    return { ok: true };
  });

  /* -------------------------------------------------------------------- */
  /* Bans                                                                  */
  /* -------------------------------------------------------------------- */

  app.post('/:serverId/bans/:userId', async (request) => {
    const { serverId, userId } = request.params as { serverId: string; userId: string };
    const reason = ((request.body as { reason?: string } | undefined)?.reason ?? '')
      .slice(0, 512)
      .trim();

    const actor = await requireMember(db, serverId, request.user!.id);
    assertPermission(actor, Permission.BAN_MEMBERS, 'ban members');

    const target = await getMemberContext(db, serverId, userId);
    if (target) assertHigherThan(actor, target, 'ban');

    await db.transaction(async (tx) => {
      await tx
        .insert(bans)
        .values({
          serverId,
          userId,
          reason: reason || null,
          bannedById: request.user!.id,
        })
        .onConflictDoNothing();
      await tx
        .delete(members)
        .where(and(eq(members.serverId, serverId), eq(members.userId, userId)));
    });

    emitToServer(ctx, serverId, 'member:leave', { serverId, userId });
    emitToUser(ctx, userId, 'server:delete', { serverId });
    await moveUserSockets(ctx, userId, Rooms.server(serverId), 'leave');

    await writeAuditLog(db, {
      serverId,
      actorId: request.user!.id,
      action: 'member.ban',
      targetType: 'user',
      targetId: userId,
      metadata: { reason },
    });

    return { ok: true };
  });

  app.delete('/:serverId/bans/:userId', async (request) => {
    const { serverId, userId } = request.params as { serverId: string; userId: string };
    const actor = await requireMember(db, serverId, request.user!.id);
    assertPermission(actor, Permission.BAN_MEMBERS, 'unban members');

    await db.delete(bans).where(and(eq(bans.serverId, serverId), eq(bans.userId, userId)));
    await writeAuditLog(db, {
      serverId,
      actorId: request.user!.id,
      action: 'member.unban',
      targetType: 'user',
      targetId: userId,
    });

    return { ok: true };
  });

  app.get('/:serverId/bans', async (request) => {
    const { serverId } = request.params as { serverId: string };
    const actor = await requireMember(db, serverId, request.user!.id);
    assertPermission(actor, Permission.BAN_MEMBERS, 'view bans');

    const rows = await db.select().from(bans).where(eq(bans.serverId, serverId));
    const userMap = await loadUsers(db, rows.map((r) => r.userId));

    return {
      bans: rows.map((row) => ({
        userId: row.userId,
        reason: row.reason,
        createdAt: row.createdAt,
        user: userMap.get(row.userId) ?? null,
      })),
    };
  });

  /* -------------------------------------------------------------------- */
  /* Leave & transfer                                                      */
  /* -------------------------------------------------------------------- */

  app.post('/:serverId/leave', async (request) => {
    const { serverId } = request.params as { serverId: string };
    const userId = request.user!.id;

    const [row] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
    if (!row) throw ApiError.notFound('Server not found');

    if (row.ownerId === userId) {
      throw ApiError.badRequest(
        'Transfer ownership or delete the server before leaving it',
      );
    }

    await requireMember(db, serverId, userId);
    await db
      .delete(members)
      .where(and(eq(members.serverId, serverId), eq(members.userId, userId)));

    emitToServer(ctx, serverId, 'member:leave', { serverId, userId });
    await moveUserSockets(ctx, userId, Rooms.server(serverId), 'leave');

    return { ok: true };
  });

  app.post('/:serverId/transfer', async (request) => {
    const { serverId } = request.params as { serverId: string };
    const { userId: newOwnerId } = (request.body ?? {}) as { userId?: string };
    if (!newOwnerId) throw ApiError.badRequest('Specify the new owner');

    const [row] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
    if (!row) throw ApiError.notFound('Server not found');
    if (row.ownerId !== request.user!.id) {
      throw ApiError.missingPermissions('Only the owner can transfer ownership');
    }

    const target = await getMemberContext(db, serverId, newOwnerId);
    if (!target) throw ApiError.badRequest('That person is not in this server');

    await db
      .update(servers)
      .set({ ownerId: newOwnerId, updatedAt: Date.now() })
      .where(eq(servers.id, serverId));

    const [updated] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
    const counts = await memberCounts(db, [serverId]);

    emitToServer(ctx, serverId, 'server:update', toServer(updated!, counts.get(serverId) ?? 0));
    await writeAuditLog(db, {
      serverId,
      actorId: request.user!.id,
      action: 'server.transfer',
      targetType: 'user',
      targetId: newOwnerId,
    });

    return { server: toServer(updated!, counts.get(serverId) ?? 0) };
  });

  /* -------------------------------------------------------------------- */
  /* Audit log                                                             */
  /* -------------------------------------------------------------------- */

  app.get('/:serverId/audit-log', async (request) => {
    const { serverId } = request.params as { serverId: string };
    const actor = await requireMember(db, serverId, request.user!.id);
    assertPermission(actor, Permission.VIEW_AUDIT_LOG, 'view the audit log');

    const rows = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.serverId, serverId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(100);

    const userMap = await loadUsers(
      db,
      rows.map((r) => r.actorId).filter((id): id is string => Boolean(id)),
    );

    return {
      entries: rows.map((row) => ({
        id: row.id,
        action: row.action,
        actorId: row.actorId,
        actor: row.actorId ? (userMap.get(row.actorId) ?? null) : null,
        targetType: row.targetType,
        targetId: row.targetId,
        metadata: row.metadata ? JSON.parse(row.metadata) : null,
        createdAt: row.createdAt,
      })),
    };
  });
}
