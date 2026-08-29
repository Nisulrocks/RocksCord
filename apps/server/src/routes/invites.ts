/**
 * Invite routes.
 *
 *   POST   /api/invites/server/:serverId  create an invite
 *   GET    /api/invites/server/:serverId  list a server's invites
 *   GET    /api/invites/:code             preview (no auth needed to look, auth to join)
 *   POST   /api/invites/:code             accept and join
 *   DELETE /api/invites/:code             revoke
 *
 * Invite preview is intentionally readable without membership -- that is the whole point
 * of an invite link -- but it exposes only the server's name, icon, and member count.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { Permission, Rooms, createInviteSchema } from '@rockscord/shared';
import { channels, invites, members, roles, servers } from '../db/schema.js';
import { ApiError, fromZodError } from '../lib/errors.js';
import { newInviteCode } from '../lib/ids.js';
import {
  assertNotBanned,
  assertPermission,
  getMemberContext,
  requireMember,
} from '../lib/permissions.js';
import {
  loadMemberRoleIds,
  toChannel,
  toInvite,
  toMember,
  toRole,
  toServer,
} from '../lib/serializers.js';
import { emitToServer, emitToUser, moveUserSockets, writeAuditLog } from '../lib/emit.js';
import { publicUserColumns } from '../lib/serializers.js';
import { users } from '../db/schema.js';

export default async function inviteRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const { db } = ctx;

  /* -------------------------------------------------------------------- */
  /* Create & list                                                         */
  /* -------------------------------------------------------------------- */

  app.post(
    '/server/:serverId',
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
    },
    async (request, reply) => {
      const { serverId } = request.params as { serverId: string };
      const parsed = createInviteSchema.safeParse(request.body ?? {});
      if (!parsed.success) throw fromZodError(parsed.error);

      const context = await requireMember(db, serverId, request.user!.id);
      assertPermission(context, Permission.CREATE_INVITE, 'create invites');

      const expiresIn = parsed.data.expiresIn;
      const code = newInviteCode();

      await db.insert(invites).values({
        code,
        serverId,
        inviterId: request.user!.id,
        maxUses: parsed.data.maxUses ?? null,
        expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null,
      });

      const [row] = await db.select().from(invites).where(eq(invites.code, code)).limit(1);
      return reply.status(201).send({ invite: toInvite(row!) });
    },
  );

  app.get(
    '/server/:serverId',
    { preHandler: app.authenticate },
    async (request) => {
      const { serverId } = request.params as { serverId: string };
      const context = await requireMember(db, serverId, request.user!.id);
      assertPermission(context, Permission.MANAGE_SERVER, 'view invites');

      const rows = await db
        .select()
        .from(invites)
        .where(eq(invites.serverId, serverId))
        .orderBy(desc(invites.createdAt))
        .limit(100);

      return { invites: rows.map((row) => toInvite(row)) };
    },
  );

  /* -------------------------------------------------------------------- */
  /* Preview                                                               */
  /* -------------------------------------------------------------------- */

  app.get('/:code', { preHandler: app.optionalAuth }, async (request) => {
    const { code } = request.params as { code: string };

    const [invite] = await db.select().from(invites).where(eq(invites.code, code)).limit(1);
    if (!invite) throw ApiError.notFound('That invite is invalid or has expired');

    if (invite.expiresAt && invite.expiresAt <= Date.now()) {
      throw ApiError.notFound('That invite has expired');
    }
    if (invite.maxUses !== null && invite.uses >= invite.maxUses) {
      throw ApiError.notFound('That invite has already been used up');
    }

    const [server] = await db
      .select()
      .from(servers)
      .where(eq(servers.id, invite.serverId))
      .limit(1);
    if (!server) throw ApiError.notFound('That server no longer exists');

    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(members)
      .where(eq(members.serverId, invite.serverId));
    const count = Number(countRow?.count ?? 0);

    const alreadyMember = request.user
      ? Boolean(await getMemberContext(db, invite.serverId, request.user.id))
      : false;

    return {
      invite: toInvite(invite, { ...toServer(server), memberCount: count }),
      alreadyMember,
    };
  });

  /* -------------------------------------------------------------------- */
  /* Accept                                                                */
  /* -------------------------------------------------------------------- */

  app.post(
    '/:code',
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
    },
    async (request) => {
      const { code } = request.params as { code: string };
      const userId = request.user!.id;

      const [invite] = await db.select().from(invites).where(eq(invites.code, code)).limit(1);
      if (!invite) throw ApiError.notFound('That invite is invalid or has expired');

      if (invite.expiresAt && invite.expiresAt <= Date.now()) {
        throw ApiError.notFound('That invite has expired');
      }
      if (invite.maxUses !== null && invite.uses >= invite.maxUses) {
        throw ApiError.notFound('That invite has already been used up');
      }

      await assertNotBanned(db, invite.serverId, userId);

      const existing = await getMemberContext(db, invite.serverId, userId);
      const [server] = await db
        .select()
        .from(servers)
        .where(eq(servers.id, invite.serverId))
        .limit(1);
      if (!server) throw ApiError.notFound('That server no longer exists');

      if (existing) {
        // Joining twice is a no-op, not an error -- clicking an invite you already
        // accepted should just take you to the server.
        return { server: toServer(server), alreadyMember: true };
      }

      await db.transaction(async (tx) => {
        await tx.insert(members).values({ serverId: invite.serverId, userId });
        await tx
          .update(invites)
          .set({ uses: sql`${invites.uses} + 1` })
          .where(eq(invites.code, code));
      });

      const [memberRow] = await db
        .select({ member: members, user: publicUserColumns })
        .from(members)
        .innerJoin(users, eq(users.id, members.userId))
        .where(and(eq(members.serverId, invite.serverId), eq(members.userId, userId)))
        .limit(1);

      const roleMap = await loadMemberRoleIds(db, invite.serverId);
      const member = toMember(memberRow!.member, memberRow!.user, roleMap.get(userId) ?? []);

      // Existing members see the newcomer; the newcomer's own clients get the server.
      emitToServer(ctx, invite.serverId, 'member:join', member);
      await moveUserSockets(ctx, userId, Rooms.server(invite.serverId), 'join');

      const [countRow] = await db
        .select({ count: sql<number>`count(*)` })
        .from(members)
        .where(eq(members.serverId, invite.serverId));
      const count = Number(countRow?.count ?? 0);

      emitToUser(ctx, userId, 'server:create', toServer(server, count));

      /*
       * Return the whole server, the same shape `POST /api/servers` returns.
       *
       * The client navigates straight in, and a server is not usable without its channels,
       * its roles, and this membership: permissions resolve through the roles, so without
       * them every check denies and the sidebar renders empty until a reload refetches
       * everything. This route already read the channels and sent only their count.
       */
      const [channelRows, roleRows] = await Promise.all([
        db.select().from(channels).where(eq(channels.serverId, invite.serverId)),
        db.select().from(roles).where(eq(roles.serverId, invite.serverId)),
      ]);

      await writeAuditLog(db, {
        serverId: invite.serverId,
        actorId: userId,
        action: 'member.join',
        targetType: 'user',
        targetId: userId,
        metadata: { inviteCode: code },
      });

      request.log.info({ serverId: invite.serverId, userId }, 'member joined via invite');

      return {
        server: toServer(server, count),
        channels: channelRows.map((row) => toChannel(row)),
        roles: roleRows.map(toRole),
        // A new member holds no explicit roles; @everyone applies to them by default.
        membership: { serverId: invite.serverId, roleIds: [] as string[], nickname: null },
        alreadyMember: false,
      };
    },
  );

  /* -------------------------------------------------------------------- */
  /* Revoke                                                                */
  /* -------------------------------------------------------------------- */

  app.delete('/:code', { preHandler: app.authenticate }, async (request) => {
    const { code } = request.params as { code: string };

    const [invite] = await db.select().from(invites).where(eq(invites.code, code)).limit(1);
    if (!invite) throw ApiError.notFound('Invite not found');

    const context = await requireMember(db, invite.serverId, request.user!.id);

    // Anyone can revoke an invite they created; revoking someone else's needs the
    // server-management permission.
    if (invite.inviterId !== request.user!.id) {
      assertPermission(context, Permission.MANAGE_SERVER, "revoke other people's invites");
    }

    await db.delete(invites).where(eq(invites.code, code));
    return { ok: true };
  });
}
