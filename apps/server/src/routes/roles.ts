/**
 * Role routes. Mounted under `/api/servers`.
 *
 *   GET    /:serverId/roles          list, highest first
 *   POST   /:serverId/roles          create
 *   PATCH  /:serverId/roles/:roleId  edit name / colour / permissions / position
 *   DELETE /:serverId/roles/:roleId  delete (never @everyone)
 *
 * Two invariants are enforced everywhere in this file:
 *  1. You cannot grant a permission you do not hold (privilege escalation).
 *  2. You cannot create, edit, or delete a role at or above your own highest position
 *     (hierarchy bypass).
 * The server owner is exempt from both.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  ALL_PERMISSIONS,
  LIMITS,
  Permission,
  createRoleSchema,
  updateRoleSchema,
} from '@rockscord/shared';
import { memberRoles, roles } from '../db/schema.js';
import { ApiError, fromZodError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { assertPermission, requireMember, type MemberContext } from '../lib/permissions.js';
import { sanitizeDisplayName } from '../lib/sanitize.js';
import { toRole } from '../lib/serializers.js';
import { emitToServer, writeAuditLog } from '../lib/emit.js';

/** Reject any attempt to put permissions into a role that the actor does not hold. */
function assertNoEscalation(actor: MemberContext, requested: number): void {
  if (actor.isOwner) return;
  const escalating = requested & ~actor.permissions & ALL_PERMISSIONS;
  if (escalating !== 0) {
    throw ApiError.missingPermissions(
      'You cannot grant permissions that you do not have yourself',
    );
  }
}

/** Reject edits to roles at or above the actor's own highest role. */
function assertBelowActor(actor: MemberContext, position: number, action: string): void {
  if (actor.isOwner) return;
  if (position >= actor.highestRolePosition) {
    throw ApiError.missingPermissions(
      `You cannot ${action} a role equal to or higher than your own`,
    );
  }
}

export default async function roleRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const { db } = ctx;

  app.addHook('preHandler', app.authenticate);

  app.get('/:serverId/roles', async (request) => {
    const { serverId } = request.params as { serverId: string };
    await requireMember(db, serverId, request.user!.id);

    const rows = await db
      .select()
      .from(roles)
      .where(eq(roles.serverId, serverId))
      .orderBy(desc(roles.position));

    return { roles: rows.map(toRole) };
  });

  app.post('/:serverId/roles', async (request, reply) => {
    const { serverId } = request.params as { serverId: string };
    const parsed = createRoleSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw fromZodError(parsed.error);

    const actor = await requireMember(db, serverId, request.user!.id);
    assertPermission(actor, Permission.MANAGE_ROLES, 'manage roles');
    assertNoEscalation(actor, parsed.data.permissions);

    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(roles)
      .where(eq(roles.serverId, serverId));
    const count = Number(countRow?.count ?? 0);

    if (count >= LIMITS.MAX_ROLES_PER_SERVER) {
      throw ApiError.badRequest(
        `A server can have at most ${LIMITS.MAX_ROLES_PER_SERVER} roles`,
      );
    }

    const [maxPositionRow] = await db
      .select({ maxPosition: sql<number>`coalesce(max(${roles.position}), 0)` })
      .from(roles)
      .where(eq(roles.serverId, serverId));
    const maxPosition = Number(maxPositionRow?.maxPosition ?? 0);

    // A new role slots in just below the creator, never above them.
    const desiredPosition = maxPosition + 1;
    const position = actor.isOwner
      ? desiredPosition
      : Math.min(desiredPosition, Math.max(1, actor.highestRolePosition - 1));

    const roleId = newId();
    await db.insert(roles).values({
      id: roleId,
      serverId,
      name: sanitizeDisplayName(parsed.data.name, LIMITS.ROLE_NAME_MAX) || 'new role',
      color: parsed.data.color,
      permissions: parsed.data.permissions,
      position,
      hoist: parsed.data.hoist,
      mentionable: parsed.data.mentionable,
      isDefault: false,
    });

    const [row] = await db.select().from(roles).where(eq(roles.id, roleId)).limit(1);
    const role = toRole(row!);

    emitToServer(ctx, serverId, 'role:create', role);
    await writeAuditLog(db, {
      serverId,
      actorId: request.user!.id,
      action: 'role.create',
      targetType: 'role',
      targetId: roleId,
      metadata: { name: role.name, permissions: role.permissions },
    });

    return reply.status(201).send({ role });
  });

  app.patch('/:serverId/roles/:roleId', async (request) => {
    const { serverId, roleId } = request.params as { serverId: string; roleId: string };
    const parsed = updateRoleSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw fromZodError(parsed.error);

    const actor = await requireMember(db, serverId, request.user!.id);
    assertPermission(actor, Permission.MANAGE_ROLES, 'manage roles');

    const [existing] = await db
      .select()
      .from(roles)
      .where(and(eq(roles.id, roleId), eq(roles.serverId, serverId)))
      .limit(1);
    if (!existing) throw ApiError.notFound('Role not found');

    assertBelowActor(actor, existing.position, 'edit');

    const patch: Record<string, unknown> = {};

    if (parsed.data.name !== undefined) {
      if (existing.isDefault) throw ApiError.badRequest('@everyone cannot be renamed');
      patch.name = sanitizeDisplayName(parsed.data.name, LIMITS.ROLE_NAME_MAX) || existing.name;
    }
    if (parsed.data.color !== undefined) patch.color = parsed.data.color;
    if (parsed.data.hoist !== undefined) patch.hoist = parsed.data.hoist;
    if (parsed.data.mentionable !== undefined) patch.mentionable = parsed.data.mentionable;

    if (parsed.data.permissions !== undefined) {
      assertNoEscalation(actor, parsed.data.permissions);
      patch.permissions = parsed.data.permissions;
    }

    if (parsed.data.position !== undefined) {
      if (existing.isDefault) throw ApiError.badRequest('@everyone is always the lowest role');
      assertBelowActor(actor, parsed.data.position, 'move a role to');
      patch.position = Math.max(1, parsed.data.position);
    }

    if (Object.keys(patch).length > 0) {
      await db.update(roles).set(patch).where(eq(roles.id, roleId));
    }

    const [row] = await db.select().from(roles).where(eq(roles.id, roleId)).limit(1);
    const role = toRole(row!);

    emitToServer(ctx, serverId, 'role:update', role);
    await writeAuditLog(db, {
      serverId,
      actorId: request.user!.id,
      action: 'role.update',
      targetType: 'role',
      targetId: roleId,
      metadata: patch,
    });

    return { role };
  });

  app.delete('/:serverId/roles/:roleId', async (request) => {
    const { serverId, roleId } = request.params as { serverId: string; roleId: string };

    const actor = await requireMember(db, serverId, request.user!.id);
    assertPermission(actor, Permission.MANAGE_ROLES, 'manage roles');

    const [existing] = await db
      .select()
      .from(roles)
      .where(and(eq(roles.id, roleId), eq(roles.serverId, serverId)))
      .limit(1);
    if (!existing) throw ApiError.notFound('Role not found');

    if (existing.isDefault) {
      throw ApiError.badRequest('The @everyone role cannot be deleted');
    }
    assertBelowActor(actor, existing.position, 'delete');

    // memberRoles rows go with it via ON DELETE CASCADE; this is explicit for clarity
    // about what happens to assignments.
    await db.delete(memberRoles).where(eq(memberRoles.roleId, roleId));
    await db.delete(roles).where(eq(roles.id, roleId));

    emitToServer(ctx, serverId, 'role:delete', { serverId, roleId });
    await writeAuditLog(db, {
      serverId,
      actorId: request.user!.id,
      action: 'role.delete',
      targetType: 'role',
      targetId: roleId,
      metadata: { name: existing.name },
    });

    return { ok: true };
  });
}
