/**
 * Application factory.
 *
 * `buildApp()` returns a fully wired but *unstarted* Fastify instance. Three very
 * different consumers use it:
 *
 *   - `src/index.ts`         the normal server process (`npm run dev`, `npm start`)
 *   - `tests/*.test.ts`      integration tests, against a private in-memory database
 *   - the Electron main process, which boots it in-process for the desktop build
 *
 * Because nothing here reads module-level singletons, those three can coexist without
 * interfering -- and the desktop app is genuinely the same server, not a reimplementation.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { LIMITS } from '@rockscord/shared';
import { env, REPO_ROOT } from './env.js';
import { createDb, pingDb, type Database, type DbHandle } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { users } from './db/schema.js';
import { verifyAccessToken } from './lib/auth.js';
import { ApiError, errorHandler } from './lib/errors.js';
import { getStorage } from './lib/storage/index.js';
import { localUploadRoot } from './lib/storage/local.js';
import type { AppContext, RequestUser } from './context.js';
import { attachGateway } from './realtime/gateway.js';

import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import serverRoutes from './routes/servers.js';
import channelRoutes from './routes/channels.js';
import messageRoutes from './routes/messages.js';
import roleRoutes from './routes/roles.js';
import inviteRoutes from './routes/invites.js';
import friendRoutes from './routes/friends.js';
import dmRoutes from './routes/dms.js';
import fileRoutes from './routes/files.js';
import searchRoutes from './routes/search.js';
import notificationRoutes from './routes/notifications.js';
import voiceRoutes from './routes/voice.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The running version, for `/health`.
 *
 * Read from the manifest rather than written here, because a hard-coded copy is a claim
 * that silently stops being true the first time anyone bumps the real one -- and a health
 * endpoint reporting the wrong version is worse than one reporting none.
 *
 * Cached: this is on a route that monitoring hits every few minutes.
 */
let cachedVersion: string | null = null;

function appVersion(): string {
  if (cachedVersion !== null) return cachedVersion;

  let resolved = 'unknown';
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    );
    const version = (manifest as { version?: unknown }).version;
    if (typeof version === 'string') resolved = version;
  } catch {
    // Packaged builds may not ship the workspace manifest; the desktop app reports its
    // own version through Electron instead.
  }

  cachedVersion = resolved;
  return resolved;
}

export interface BuildAppOptions {
  /** Supply an existing database (tests do this). Otherwise one is opened from env. */
  db?: Database;
  /** Run pending migrations during boot. Default true -- this is what makes setup zero-step. */
  migrate?: boolean;
  /** Attach the Socket.IO gateway. Default true. */
  realtime?: boolean;
  /** Override the log level for this instance. */
  logLevel?: string;
}

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
  close: () => Promise<void>;
}

/** Locate the built web client, if it exists, so the API can serve it as a single service. */
function findClientDist(): string | null {
  const candidates = [
    path.join(REPO_ROOT, 'apps', 'web', 'dist'),
    path.resolve(here, '..', 'public'),
    ...(process.resourcesPath ? [path.join(process.resourcesPath, 'web')] : []),
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<BuiltApp> {
  const { migrate = true, realtime = true } = options;

  let ownedHandle: DbHandle | null = null;
  let db: Database;

  if (options.db) {
    db = options.db;
  } else {
    ownedHandle = await createDb();
    db = ownedHandle.db;
  }

  if (migrate) await runMigrations(db);

  const app = Fastify({
    logger: {
      level: options.logLevel ?? (env.isTest ? 'silent' : env.LOG_LEVEL),
      ...(env.isProduction || env.isTest
        ? {}
        : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }),
    },
    // Behind Render/Fly/nginx the client IP arrives in X-Forwarded-For. Rate limiting by
    // the proxy's IP would otherwise throttle every user as if they were one person.
    trustProxy: true,
    bodyLimit: 1024 * 1024, // 1 MB for JSON; file uploads go through multipart instead.
  });

  const ctx: AppContext = { db, gateway: null };
  app.decorate('ctx', ctx);

  app.setErrorHandler(errorHandler);

  // Resolved up front because it decides how the (single, Fastify allows only one)
  // not-found handler behaves: API-style JSON 404, or SPA fallback to index.html.
  const clientDist = env.SERVE_CLIENT ? findClientDist() : null;

  app.setNotFoundHandler((request, reply) => {
    const isApiPath =
      request.url.startsWith('/api') ||
      request.url.startsWith('/uploads') ||
      request.url.startsWith('/socket.io');

    if (clientDist && !isApiPath && request.method === 'GET') {
      // Client-side routes such as /channels/:id must survive a hard refresh.
      reply.sendFile('index.html', clientDist);
      return;
    }

    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `No route for ${request.method} ${request.url}` },
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Plugins                                                                 */
  /* ---------------------------------------------------------------------- */

  await app.register(cors, {
    origin: env.corsOrigins,
    // Required for the refresh-token cookie to be sent on cross-origin requests.
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  await app.register(cookie, { secret: env.JWT_SECRET });

  /*
   * Treat an empty body as `{}` rather than a parse error.
   *
   * Several routes take no body at all (accepting an invite, logging out, refreshing).
   * Fastify's default JSON parser rejects `Content-Type: application/json` with a zero
   * length body as malformed, so a client that sets the header unconditionally -- which
   * is the natural thing to do, and what `curl -H` users hit -- gets a confusing 400.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body: string, done) => {
      if (!body || body.trim().length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(body));
      } catch (error) {
        const failure = error as Error & { statusCode?: number };
        failure.statusCode = 400;
        done(failure, undefined);
      }
    },
  );

  await app.register(multipart, {
    limits: {
      fileSize: LIMITS.MAX_UPLOAD_BYTES,
      files: LIMITS.MAX_ATTACHMENTS_PER_MESSAGE,
      fields: 10,
    },
  });

  if (env.RATE_LIMIT_ENABLED) {
    // A global backstop. Individual routes (login, register, message send) declare their
    // own tighter limits via route-level `config.rateLimit`.
    await app.register(rateLimit, {
      global: true,
      max: 300,
      timeWindow: '1 minute',
      // Rate limit per authenticated user when we know who they are, otherwise per IP.
      // Without this, everyone behind one NAT shares a single bucket.
      keyGenerator: (request) => request.user?.id ?? request.ip,
      addHeadersOnExceeding: { 'x-ratelimit-remaining': true },
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Authentication decorators                                               */
  /* ---------------------------------------------------------------------- */

  async function resolveUser(token: string): Promise<RequestUser | null> {
    const claims = await verifyAccessToken(token);
    if (!claims) return null;

    /*
     * The token is signed, but says nothing about the account still existing.
     *
     * `deletedAt IS NULL` is the load-bearing half. Deleting an account revokes its
     * sessions, which stops *refresh* -- but an access token already in flight stays
     * cryptographically valid until it expires, and the tombstoned row would still
     * resolve. Without this check a deleted account keeps acting for up to fifteen
     * minutes: posting, joining, reading. Caught by a test that deletes an account and
     * then reuses its token.
     */
    const [row] = await db
      .select({
        id: users.id,
        username: users.username,
        discriminator: users.discriminator,
        displayName: users.displayName,
        email: users.email,
        passwordChangedAt: users.passwordChangedAt,
      })
      .from(users)
      .where(and(eq(users.id, claims.sub), isNull(users.deletedAt)))
      .limit(1);

    if (!row) return null;

    /*
     * Reject tokens minted before the password changed.
     *
     * Same shape of hole as the tombstone check above: revoking sessions stops refresh,
     * but an access token already in flight keeps working until it expires. For a
     * password *reset* that is the whole point of the exercise -- someone resetting has
     * usually lost control of the account, and a fifteen-minute grace period for whoever
     * took it is not a grace period worth having.
     *
     * Compared at second granularity because `iat` is whole seconds. A token issued in
     * the same second as the change survives, which is what keeps the caller's own new
     * token working after an in-app password change.
     */
    if ((claims.iat ?? 0) < Math.floor(row.passwordChangedAt / 1000)) return null;

    const { passwordChangedAt: _ignored, ...user } = row;
    return { ...user, sessionId: claims.sid };
  }

  function extractToken(header: string | undefined): string | null {
    if (!header) return null;
    const [scheme, value] = header.split(' ');
    if (!value || scheme?.toLowerCase() !== 'bearer') return null;
    return value.trim() || null;
  }

  app.decorate('authenticate', async (request) => {
    const token = extractToken(request.headers.authorization);
    if (!token) throw ApiError.unauthorized();

    const user = await resolveUser(token);
    if (!user) {
      // 401 with this code is the client's signal to attempt a silent refresh and retry.
      throw new ApiError(401, 'TOKEN_EXPIRED', 'Your session expired');
    }
    request.user = user;
  });

  app.decorate('optionalAuth', async (request) => {
    const token = extractToken(request.headers.authorization);
    if (!token) return;
    const user = await resolveUser(token);
    if (user) request.user = user;
  });

  /* ---------------------------------------------------------------------- */
  /* Routes                                                                  */
  /* ---------------------------------------------------------------------- */

  app.get('/health', async () => ({
    status: 'ok',
    database: (await pingDb(db)) ? 'up' : 'down',
    /*
     * Which storage driver is live.
     *
     * Worth reporting because the wrong one fails invisibly: `local` on a host with no
     * persistent disk accepts every upload and serves it back happily, right up until the
     * next deploy erases the lot. Nothing errors, and the damage only shows as avatars
     * quietly turning back into initials days later.
     *
     * The name alone is not a secret -- it says nothing about the bucket or the keys.
     */
    storage: (await getStorage()).name,
    uptimeSeconds: Math.round(process.uptime()),
    version: appVersion(),
  }));

  await app.register(
    async (api) => {
      await api.register(authRoutes, { prefix: '/auth' });
      await api.register(userRoutes, { prefix: '/users' });
      await api.register(serverRoutes, { prefix: '/servers' });
      await api.register(channelRoutes, { prefix: '/channels' });
      await api.register(messageRoutes, { prefix: '/channels' });
      await api.register(roleRoutes, { prefix: '/servers' });
      await api.register(inviteRoutes, { prefix: '/invites' });
      await api.register(friendRoutes, { prefix: '/friends' });
      await api.register(dmRoutes, { prefix: '/dms' });
      await api.register(fileRoutes, { prefix: '/files' });
      await api.register(searchRoutes, { prefix: '/search' });
      await api.register(notificationRoutes, { prefix: '/notifications' });
      await api.register(voiceRoutes, { prefix: '/voice' });
    },
    { prefix: '/api' },
  );

  /* ---------------------------------------------------------------------- */
  /* Static assets                                                           */
  /* ---------------------------------------------------------------------- */

  if (env.STORAGE_DRIVER === 'local') {
    // @fastify/static refuses to mount a root that does not exist yet, and the storage
    // driver only creates it lazily on first upload. Create it now so a fresh install
    // (no uploads yet) starts without a warning.
    mkdirSync(localUploadRoot(), { recursive: true });

    await app.register(fastifyStatic, {
      root: localUploadRoot(),
      prefix: '/uploads/',
      decorateReply: false,
      index: false,
      // Files here are user-supplied, so they are served defensively: never sniffed,
      // never rendered as a document, and only images are allowed to display inline.
      /*
       * `reply` really is a FastifyReply here, so headers are set with `.header()`.
       * Calling Node's `.setHeader()` throws *inside* the send pipeline, which does not
       * surface as a 500 — the response simply never completes and the request hangs
       * until the client times out. Covered by a test that fetches a real file.
       */
      setHeaders: (reply, filePath) => {
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header(
          'Content-Security-Policy',
          "default-src 'none'; img-src 'self'; media-src 'self'; sandbox",
        );
        reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        // Only media renders inline. Everything else downloads, so a crafted file can
        // never be navigated to and executed as a document in the app's origin.
        if (!/\.(png|jpe?g|gif|webp|avif|bmp|mp4|webm|mp3|ogg|wav)$/i.test(filePath)) {
          reply.header('Content-Disposition', 'attachment');
        }
      },
    });
  }

  if (clientDist) {
    app.log.info(`serving web client from ${clientDist}`);
    // `decorateReply: true` (the default) is required here because the not-found handler
    // above calls `reply.sendFile` for the SPA fallback.
    await app.register(fastifyStatic, {
      root: clientDist,
      prefix: '/',
      index: ['index.html'],
    });
  }

  await app.ready();

  if (realtime) {
    ctx.gateway = attachGateway(app, ctx);
  }

  return {
    app,
    ctx,
    close: async () => {
      if (ctx.gateway) {
        await new Promise<void>((resolve) => ctx.gateway!.close(() => resolve()));
      }
      await app.close();
      if (ownedHandle) await ownedHandle.close();
    },
  };
}
