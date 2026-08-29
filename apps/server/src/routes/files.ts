/**
 * Upload routes.
 *
 *   POST /api/files/upload   attachment for a message (returns an id to attach)
 *   POST /api/files/avatar   replace the caller's avatar
 *   POST /api/files/icon     upload a server icon (requires MANAGE_SERVER)
 *
 * The upload pipeline, in order:
 *   1. multipart limits cap the stream (8 MB) before it is fully read
 *   2. the byte count is re-checked after buffering, since a limit can be hit mid-stream
 *   3. the real MIME type is sniffed from the leading bytes, never trusted from the client
 *   4. the sniffed type must be on the allow-list
 *   5. the filename is stripped of paths, traversal, and reserved names
 *   6. image dimensions are read so the client can reserve layout space
 *   7. the object lands under an unguessable key
 *
 * Attachments are uploaded *before* the message exists and claimed when it is sent. That
 * is what lets the composer upload in the background while the user is still typing.
 */

import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { imageSize } from 'image-size';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  ALLOWED_UPLOAD_MIME_TYPES,
  IMAGE_MIME_TYPES,
  LIMITS,
  Permission,
  createEmojiSchema,
} from '@rockscord/shared';
import { attachments, emojis, servers, users } from '../db/schema.js';
import { ApiError, fromZodError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { assertPermission, requireMember } from '../lib/permissions.js';
import { sanitizeFileName } from '../lib/sanitize.js';
import { resolveUploadType } from '../lib/filetype.js';
import { buildStorageKey, getStorage } from '../lib/storage/index.js';
import { toAttachment } from '../lib/serializers.js';
import { emitToServer } from '../lib/emit.js';

const ALLOWED = new Set<string>(ALLOWED_UPLOAD_MIME_TYPES);

interface AcceptedUpload {
  buffer: Buffer;
  fileName: string;
  contentType: string;
  width: number | null;
  height: number | null;
}

/** Read one file from a multipart request and run it through every validation step. */
async function acceptUpload(
  request: FastifyRequest,
  opts: { imagesOnly?: boolean; maxBytes?: number } = {},
): Promise<AcceptedUpload> {
  const maxBytes = opts.maxBytes ?? LIMITS.MAX_UPLOAD_BYTES;

  const part = await request.file({ limits: { fileSize: maxBytes } });
  if (!part) throw ApiError.badRequest('No file was uploaded');

  const buffer = await part.toBuffer();

  // `truncated` is set when the stream hit the limit; the buffer would be a partial file.
  if (part.file.truncated || buffer.length > maxBytes) {
    throw ApiError.tooLarge(
      `Files must be ${Math.floor(maxBytes / (1024 * 1024))} MB or smaller`,
    );
  }
  if (buffer.length === 0) throw ApiError.badRequest('That file is empty');

  const contentType = resolveUploadType(buffer, part.mimetype ?? '');
  if (!contentType || !ALLOWED.has(contentType)) {
    throw ApiError.unsupportedMedia(
      'That file type is not allowed. Images, PDFs, text, audio, video, and zip files are accepted.',
    );
  }

  if (opts.imagesOnly && !IMAGE_MIME_TYPES.has(contentType)) {
    throw ApiError.unsupportedMedia('That needs to be an image');
  }

  let width: number | null = null;
  let height: number | null = null;
  if (IMAGE_MIME_TYPES.has(contentType)) {
    try {
      const dimensions = imageSize(buffer);
      width = dimensions.width ?? null;
      height = dimensions.height ?? null;
    } catch {
      // A file that sniffs as an image but has no readable header is suspicious enough
      // to reject: it would render as a broken image for everyone anyway.
      throw ApiError.unsupportedMedia('That image could not be read');
    }
  }

  return {
    buffer,
    fileName: sanitizeFileName(part.filename ?? 'file'),
    contentType,
    width,
    height,
  };
}

export default async function fileRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const { db } = ctx;

  app.addHook('preHandler', app.authenticate);

  /* -------------------------------------------------------------------- */
  /* Message attachments                                                   */
  /* -------------------------------------------------------------------- */

  app.post(
    '/upload',
    { config: { rateLimit: { max: 20, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const upload = await acceptUpload(request);
      const storage = await getStorage();

      const key = buildStorageKey(upload.fileName);
      await storage.put(key, upload.buffer, upload.contentType);

      const id = newId();
      await db.insert(attachments).values({
        id,
        messageId: null, // claimed when the message that references it is created
        uploaderId: request.user!.id,
        fileName: upload.fileName,
        contentType: upload.contentType,
        size: upload.buffer.length,
        storageKey: key,
        width: upload.width,
        height: upload.height,
      });

      const [row] = await db.select().from(attachments).where(eq(attachments.id, id)).limit(1);
      return reply.status(201).send({ attachment: await toAttachment(row!) });
    },
  );

  /* -------------------------------------------------------------------- */
  /* Avatars                                                               */
  /* -------------------------------------------------------------------- */

  app.post(
    '/avatar',
    { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (request) => {
      // 2 MB is plenty for an avatar and keeps the free storage tier from filling up
      // with 8 MB profile pictures.
      const upload = await acceptUpload(request, { imagesOnly: true, maxBytes: 2 * 1024 * 1024 });
      const storage = await getStorage();

      const key = buildStorageKey(upload.fileName);
      await storage.put(key, upload.buffer, upload.contentType);
      const url = storage.urlFor(key);

      const [previous] = await db
        .select({ avatarUrl: users.avatarUrl })
        .from(users)
        .where(eq(users.id, request.user!.id))
        .limit(1);

      await db
        .update(users)
        .set({ avatarUrl: url, updatedAt: Date.now() })
        .where(eq(users.id, request.user!.id));

      request.log.info({ userId: request.user!.id, previous: previous?.avatarUrl }, 'avatar updated');
      return { avatarUrl: url };
    },
  );

  /* -------------------------------------------------------------------- */
  /* Server icons                                                          */
  /* -------------------------------------------------------------------- */

  app.post(
    '/icon/:serverId',
    { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (request) => {
      const { serverId } = request.params as { serverId: string };

      const context = await requireMember(db, serverId, request.user!.id);
      assertPermission(context, Permission.MANAGE_SERVER, 'change the server icon');

      const upload = await acceptUpload(request, { imagesOnly: true, maxBytes: 2 * 1024 * 1024 });
      const storage = await getStorage();

      const key = buildStorageKey(upload.fileName);
      await storage.put(key, upload.buffer, upload.contentType);
      const url = storage.urlFor(key);

      await db
        .update(servers)
        .set({ iconUrl: url, updatedAt: Date.now() })
        .where(eq(servers.id, serverId));

      const [row] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
      emitToServer(ctx, serverId, 'server:update', {
        id: row!.id,
        name: row!.name,
        iconUrl: row!.iconUrl,
        description: row!.description,
        ownerId: row!.ownerId,
        createdAt: row!.createdAt,
      });

      return { iconUrl: url };
    },
  );

  /* -------------------------------------------------------------------- */
  /* Custom emoji                                                          */
  /* -------------------------------------------------------------------- */

  /**
   * Upload a custom emoji for a server.
   *
   * The name arrives as a query parameter rather than a form field because
   * `acceptUpload` reads a single file part and knows nothing about the rest of the
   * multipart body. A name is not secret, so a query string costs nothing here and keeps
   * the shared upload helper unchanged.
   */
  app.post(
    '/emoji/:serverId',
    { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (request) => {
      const { serverId } = request.params as { serverId: string };

      const context = await requireMember(db, serverId, request.user!.id);
      assertPermission(context, Permission.MANAGE_SERVER, 'manage emoji');

      const parsed = createEmojiSchema.safeParse(request.query);
      if (!parsed.success) throw fromZodError(parsed.error);
      const { name } = parsed.data;

      const [existing] = await db
        .select({ id: emojis.id })
        .from(emojis)
        .where(and(eq(emojis.serverId, serverId), eq(emojis.name, name)))
        .limit(1);
      if (existing) {
        throw ApiError.alreadyExists(`This server already has an emoji called :${name}:`);
      }

      const [counted] = await db
        .select({ count: sql<number>`count(*)` })
        .from(emojis)
        .where(eq(emojis.serverId, serverId));
      if (Number(counted?.count ?? 0) >= LIMITS.MAX_EMOJIS_PER_SERVER) {
        throw ApiError.conflict(
          `A server can have at most ${LIMITS.MAX_EMOJIS_PER_SERVER} custom emoji.`,
        );
      }

      const upload = await acceptUpload(request, {
        imagesOnly: true,
        maxBytes: LIMITS.MAX_EMOJI_BYTES,
      });

      const storage = await getStorage();
      const key = buildStorageKey(upload.fileName);
      await storage.put(key, upload.buffer, upload.contentType);

      const row = {
        id: newId(),
        serverId,
        name,
        imageUrl: storage.urlFor(key),
        createdBy: request.user!.id,
        createdAt: Date.now(),
      };
      await db.insert(emojis).values(row);

      const emoji = {
        id: row.id,
        serverId: row.serverId,
        name: row.name,
        imageUrl: row.imageUrl,
        createdAt: row.createdAt,
      };
      emitToServer(ctx, serverId, 'emoji:create', emoji);
      return { emoji };
    },
  );
}

/**
 * Delete attachment rows (and their objects) that were uploaded but never attached to a
 * message. Without this, an abandoned composer leaks storage forever.
 *
 * Called on an interval from `index.ts` rather than on a schedule service, because the
 * free hosting tier has no cron.
 */
export async function sweepOrphanedAttachments(
  db: FastifyInstance['ctx']['db'],
  olderThanMs = 24 * 60 * 60 * 1000,
): Promise<number> {
  const cutoff = Date.now() - olderThanMs;

  const orphans = await db
    .select({ id: attachments.id, storageKey: attachments.storageKey })
    .from(attachments)
    .where(and(isNull(attachments.messageId), lt(attachments.createdAt, cutoff)))
    .limit(200);

  if (orphans.length === 0) return 0;

  const storage = await getStorage();
  for (const orphan of orphans) {
    try {
      await storage.remove(orphan.storageKey);
    } catch {
      // Leave the row in place so the next sweep retries the object deletion.
      continue;
    }
    await db.delete(attachments).where(eq(attachments.id, orphan.id));
  }

  return orphans.length;
}
