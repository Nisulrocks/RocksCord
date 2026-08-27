/**
 * Notification routes.
 *
 *   GET    /api/notifications            recent notifications (newest first)
 *   POST   /api/notifications/read       mark specific ones, or all, as read
 *   DELETE /api/notifications/:id        dismiss one
 *   DELETE /api/notifications            clear all
 *
 * These back the notification tray. Live delivery happens over the socket; this endpoint
 * exists so a client that was offline can catch up on what it missed.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { notifications } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';

export default async function notificationRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.ctx;

  app.addHook('preHandler', app.authenticate);

  app.get('/', async (request) => {
    const { unreadOnly } = request.query as { unreadOnly?: string };

    const conditions = [eq(notifications.userId, request.user!.id)];
    if (unreadOnly === 'true') conditions.push(eq(notifications.read, false));

    const rows = await db
      .select()
      .from(notifications)
      .where(and(...conditions))
      .orderBy(desc(notifications.createdAt))
      .limit(100);

    return {
      notifications: rows,
      unreadCount: rows.filter((r) => !r.read).length,
    };
  });

  app.post('/read', async (request) => {
    const { ids, all } = (request.body ?? {}) as { ids?: string[]; all?: boolean };
    const userId = request.user!.id;

    if (all) {
      await db
        .update(notifications)
        .set({ read: true })
        .where(and(eq(notifications.userId, userId), eq(notifications.read, false)));
      return { ok: true };
    }

    if (!Array.isArray(ids) || ids.length === 0) {
      throw ApiError.badRequest('Provide `ids` or set `all` to true');
    }

    // The userId condition is what stops one user marking another user's tray as read.
    await db
      .update(notifications)
      .set({ read: true })
      .where(
        and(eq(notifications.userId, userId), inArray(notifications.id, ids.slice(0, 200))),
      );

    return { ok: true };
  });

  app.delete('/:notificationId', async (request) => {
    const { notificationId } = request.params as { notificationId: string };

    await db
      .delete(notifications)
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.userId, request.user!.id),
        ),
      );

    return { ok: true };
  });

  app.delete('/', async (request) => {
    await db.delete(notifications).where(eq(notifications.userId, request.user!.id));
    return { ok: true };
  });
}
