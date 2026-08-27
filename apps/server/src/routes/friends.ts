/**
 * Friend routes.
 *
 *   GET    /api/friends            accepted friends, incoming and outgoing requests
 *   POST   /api/friends/requests   send a request by username or full handle
 *   POST   /api/friends/:id/accept accept an incoming request
 *   DELETE /api/friends/:id        reject a request, cancel one, or remove a friend
 *   POST   /api/friends/:userId/block   block someone
 *   DELETE /api/friends/:userId/block   unblock
 *
 * A relationship is one row, keyed on the *ordered* id pair (`userLowId`, `userHighId`),
 * so A->B and B->A cannot both exist. `requesterId` records who initiated, which is what
 * distinguishes an incoming request from an outgoing one.
 */

import { and, eq, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { friendRequestSchema } from '@rockscord/shared';
import { friendships, users } from '../db/schema.js';
import { ApiError, fromZodError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { loadUsers, publicUserColumns, toFriendship } from '../lib/serializers.js';
import { emitToUser } from '../lib/emit.js';
import { createNotification } from '../lib/notifications.js';
import type { Database } from '../db/index.js';

/** Canonical ordering of a user pair, so the unique index can do its job. */
function orderedPair(a: string, b: string): { low: string; high: string } {
  return a < b ? { low: a, high: b } : { low: b, high: a };
}

async function findRelationship(db: Database, a: string, b: string) {
  const { low, high } = orderedPair(a, b);
  const [row] = await db
    .select()
    .from(friendships)
    .where(and(eq(friendships.userLowId, low), eq(friendships.userHighId, high)))
    .limit(1);
  return row ?? null;
}

export default async function friendRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const { db } = ctx;

  app.addHook('preHandler', app.authenticate);

  /* -------------------------------------------------------------------- */
  /* List                                                                  */
  /* -------------------------------------------------------------------- */

  app.get('/', async (request) => {
    const userId = request.user!.id;

    const rows = await db
      .select()
      .from(friendships)
      .where(or(eq(friendships.requesterId, userId), eq(friendships.addresseeId, userId)));

    const otherIds = rows.map((row) =>
      row.requesterId === userId ? row.addresseeId : row.requesterId,
    );
    const userMap = await loadUsers(db, otherIds);

    const friends = [];
    const incoming = [];
    const outgoing = [];
    const blocked = [];

    for (const row of rows) {
      const otherId = row.requesterId === userId ? row.addresseeId : row.requesterId;
      const other = userMap.get(otherId);
      if (!other) continue;

      const dto = toFriendship(row, other);
      if (row.status === 'accepted') friends.push(dto);
      else if (row.status === 'blocked') {
        // Only the blocker sees the block; the blocked user just sees nothing.
        if (row.requesterId === userId) blocked.push(dto);
      } else if (row.requesterId === userId) outgoing.push(dto);
      else incoming.push(dto);
    }

    return { friends, incoming, outgoing, blocked };
  });

  /* -------------------------------------------------------------------- */
  /* Send request                                                          */
  /* -------------------------------------------------------------------- */

  app.post(
    '/requests',
    { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const parsed = friendRequestSchema.safeParse(request.body);
      if (!parsed.success) throw fromZodError(parsed.error);

      const userId = request.user!.id;
      const [namePart, tagPart] = parsed.data.username.split('#');
      const usernameLower = (namePart ?? '').trim().toLowerCase();
      if (!usernameLower) throw ApiError.badRequest('Enter a username');

      const candidates = await db
        .select(publicUserColumns)
        .from(users)
        .where(eq(users.usernameLower, usernameLower))
        .limit(20);

      const target = tagPart
        ? candidates.find((c) => c.discriminator === tagPart)
        : candidates.length === 1
          ? candidates[0]
          : undefined;

      if (!target) {
        if (candidates.length > 1) {
          throw ApiError.badRequest(
            'Several people use that username. Include the tag, like name#0417.',
          );
        }
        throw ApiError.notFound('No user with that username');
      }

      if (target.id === userId) {
        throw ApiError.badRequest('You cannot add yourself');
      }

      const existing = await findRelationship(db, userId, target.id);

      if (existing) {
        if (existing.status === 'accepted') {
          throw ApiError.conflict('You are already friends');
        }
        if (existing.status === 'blocked') {
          // Do not reveal that the other party blocked you.
          throw ApiError.badRequest('That request could not be sent');
        }
        if (existing.requesterId === userId) {
          throw ApiError.conflict('You already sent them a request');
        }

        // They already asked you -- treat this as accepting rather than as a duplicate.
        await db
          .update(friendships)
          .set({ status: 'accepted', updatedAt: Date.now() })
          .where(eq(friendships.id, existing.id));

        const [updated] = await db
          .select()
          .from(friendships)
          .where(eq(friendships.id, existing.id))
          .limit(1);

        const [me] = await db.select(publicUserColumns).from(users).where(eq(users.id, userId));

        emitToUser(ctx, target.id, 'friend:update', toFriendship(updated!, me!));
        return reply.send({ friendship: toFriendship(updated!, target), accepted: true });
      }

      const { low, high } = orderedPair(userId, target.id);
      const id = newId();

      await db.insert(friendships).values({
        id,
        requesterId: userId,
        addresseeId: target.id,
        userLowId: low,
        userHighId: high,
        status: 'pending',
      });

      const [row] = await db.select().from(friendships).where(eq(friendships.id, id)).limit(1);
      const [me] = await db.select(publicUserColumns).from(users).where(eq(users.id, userId));

      emitToUser(ctx, target.id, 'friend:request', toFriendship(row!, me!));
      await createNotification(ctx, db, {
        userId: target.id,
        type: 'friend_request',
        title: 'New friend request',
        body: `${request.user!.displayName} wants to be friends`,
      });

      return reply.status(201).send({ friendship: toFriendship(row!, target) });
    },
  );

  /* -------------------------------------------------------------------- */
  /* Accept                                                                */
  /* -------------------------------------------------------------------- */

  app.post('/:friendshipId/accept', async (request) => {
    const { friendshipId } = request.params as { friendshipId: string };
    const userId = request.user!.id;

    const [row] = await db
      .select()
      .from(friendships)
      .where(eq(friendships.id, friendshipId))
      .limit(1);

    if (!row) throw ApiError.notFound('Request not found');
    if (row.addresseeId !== userId) {
      // Only the person who received the request may accept it.
      throw ApiError.notFound('Request not found');
    }
    if (row.status !== 'pending') throw ApiError.badRequest('That request is no longer pending');

    await db
      .update(friendships)
      .set({ status: 'accepted', updatedAt: Date.now() })
      .where(eq(friendships.id, friendshipId));

    const [updated] = await db
      .select()
      .from(friendships)
      .where(eq(friendships.id, friendshipId))
      .limit(1);

    const userMap = await loadUsers(db, [row.requesterId, row.addresseeId]);
    const requester = userMap.get(row.requesterId)!;
    const addressee = userMap.get(row.addresseeId)!;

    emitToUser(ctx, row.requesterId, 'friend:update', toFriendship(updated!, addressee));
    return { friendship: toFriendship(updated!, requester) };
  });

  /* -------------------------------------------------------------------- */
  /* Reject / cancel / remove                                              */
  /* -------------------------------------------------------------------- */

  app.delete('/:friendshipId', async (request) => {
    const { friendshipId } = request.params as { friendshipId: string };
    const userId = request.user!.id;

    const [row] = await db
      .select()
      .from(friendships)
      .where(eq(friendships.id, friendshipId))
      .limit(1);

    if (!row) throw ApiError.notFound('Not found');
    if (row.requesterId !== userId && row.addresseeId !== userId) {
      throw ApiError.notFound('Not found');
    }

    await db.delete(friendships).where(eq(friendships.id, friendshipId));

    const otherId = row.requesterId === userId ? row.addresseeId : row.requesterId;
    emitToUser(ctx, otherId, 'friend:remove', { userId });

    return { ok: true };
  });

  /* -------------------------------------------------------------------- */
  /* Block / unblock                                                       */
  /* -------------------------------------------------------------------- */

  app.post('/:userId/block', async (request) => {
    const { userId: targetId } = request.params as { userId: string };
    const userId = request.user!.id;

    if (targetId === userId) throw ApiError.badRequest('You cannot block yourself');

    const [target] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, targetId))
      .limit(1);
    if (!target) throw ApiError.notFound('No such user');

    const existing = await findRelationship(db, userId, targetId);
    const { low, high } = orderedPair(userId, targetId);

    if (existing) {
      await db
        .update(friendships)
        .set({ status: 'blocked', requesterId: userId, updatedAt: Date.now() })
        .where(eq(friendships.id, existing.id));
    } else {
      await db.insert(friendships).values({
        id: newId(),
        requesterId: userId,
        addresseeId: targetId,
        userLowId: low,
        userHighId: high,
        status: 'blocked',
      });
    }

    emitToUser(ctx, targetId, 'friend:remove', { userId });
    return { ok: true };
  });

  app.delete('/:userId/block', async (request) => {
    const { userId: targetId } = request.params as { userId: string };
    const userId = request.user!.id;

    const existing = await findRelationship(db, userId, targetId);
    if (!existing || existing.status !== 'blocked' || existing.requesterId !== userId) {
      throw ApiError.notFound('You have not blocked that person');
    }

    await db.delete(friendships).where(eq(friendships.id, existing.id));
    return { ok: true };
  });
}
