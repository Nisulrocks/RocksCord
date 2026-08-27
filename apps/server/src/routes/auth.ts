/**
 * Authentication routes.
 *
 *   POST /api/auth/register   create an account and sign in
 *   POST /api/auth/login      sign in
 *   POST /api/auth/refresh    rotate the refresh token, mint a new access token
 *   POST /api/auth/logout     revoke the current session
 *   POST /api/auth/logout-all revoke every session for the account
 *   GET  /api/auth/me         the signed-in user
 *   PATCH /api/auth/password  change password (revokes all other sessions)
 *
 * Rate limits here are tighter than the global default because these are the endpoints
 * worth brute-forcing.
 */

import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  changePasswordSchema,
  loginSchema,
  registerSchema,
  LIMITS,
} from '@rockscord/shared';
import { env } from '../env.js';
import { sessions, users } from '../db/schema.js';
import {
  REFRESH_COOKIE_NAME,
  clearedRefreshCookieOptions,
  fakeVerifyPassword,
  generateRefreshToken,
  hashPassword,
  hashRefreshToken,
  refreshCookieOptions,
  signAccessToken,
  verifyPassword,
} from '../lib/auth.js';
import { ApiError, fromZodError } from '../lib/errors.js';
import { newDiscriminator, newId } from '../lib/ids.js';
import { sanitizeDisplayName } from '../lib/sanitize.js';
import { toSelfUser } from '../lib/serializers.js';
import type { Database } from '../db/index.js';

/**
 * Issue a fresh session: store the hashed refresh token, set the cookie, return an
 * access token. Called by register, login, and refresh alike so the three cannot drift.
 */
async function issueSession(
  db: Database,
  reply: FastifyReply,
  request: FastifyRequest,
  userId: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  const sessionId = newId();
  const refreshToken = generateRefreshToken();

  await db.insert(sessions).values({
    id: sessionId,
    userId,
    tokenHash: hashRefreshToken(refreshToken),
    userAgent: request.headers['user-agent']?.slice(0, 256) ?? null,
    ipAddress: request.ip?.slice(0, 64) ?? null,
    expiresAt: Date.now() + env.REFRESH_TOKEN_TTL_SECONDS * 1000,
  });

  reply.setCookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());

  return {
    accessToken: await signAccessToken(userId, sessionId),
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
  };
}

/**
 * Pick a free 4-digit tag for a username.
 *
 * Usernames are not globally unique -- `alex#0417` and `alex#8823` are different people.
 * This tries random tags first (cheap, and almost always succeeds) before falling back to
 * scanning for any free tag, so a popular name does not fail registration outright.
 */
async function allocateDiscriminator(
  db: Database,
  usernameLower: string,
): Promise<string> {
  const taken = new Set(
    (
      await db
        .select({ discriminator: users.discriminator })
        .from(users)
        .where(eq(users.usernameLower, usernameLower))
    ).map((row) => row.discriminator),
  );

  if (taken.size >= 9999) {
    throw ApiError.conflict('That username is full. Try a different one.');
  }

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = newDiscriminator();
    if (!taken.has(candidate)) return candidate;
  }

  for (let i = 1; i <= 9999; i += 1) {
    const candidate = String(i).padStart(4, '0');
    if (!taken.has(candidate)) return candidate;
  }

  throw ApiError.conflict('That username is full. Try a different one.');
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.ctx;

  /* -------------------------------------------------------------------- */
  /* Register                                                              */
  /* -------------------------------------------------------------------- */

  app.post(
    '/register',
    { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      if (!env.ALLOW_REGISTRATION) {
        throw new ApiError(
          403,
          'REGISTRATION_DISABLED',
          'Registration is closed on this server',
        );
      }

      const parsed = registerSchema.safeParse(request.body);
      if (!parsed.success) throw fromZodError(parsed.error);

      const { email, username, password } = parsed.data;
      const usernameLower = username.toLowerCase();
      const displayName =
        sanitizeDisplayName(parsed.data.displayName ?? username) || username;

      const [existingEmail] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (existingEmail) {
        // This does leak that an email is registered. That is a deliberate trade: the
        // alternative (a silent success that sends a "you already have an account" email)
        // needs an email provider, which this project intentionally does not have.
        throw ApiError.alreadyExists('An account with that email already exists');
      }

      const discriminator = await allocateDiscriminator(db, usernameLower);
      const passwordHash = await hashPassword(password);
      const userId = newId();
      const timestamp = Date.now();

      await db.insert(users).values({
        id: userId,
        email,
        username,
        usernameLower,
        discriminator,
        displayName,
        passwordHash,
        status: 'online',
        createdAt: timestamp,
        updatedAt: timestamp,
        lastSeenAt: timestamp,
      });

      const [created] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      const tokens = await issueSession(db, reply, request, userId);

      request.log.info({ userId, username: `${username}#${discriminator}` }, 'user registered');

      return reply.status(201).send({ user: toSelfUser(created!), ...tokens });
    },
  );

  /* -------------------------------------------------------------------- */
  /* Login                                                                 */
  /* -------------------------------------------------------------------- */

  app.post(
    '/login',
    { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) throw fromZodError(parsed.error);

      const { identifier, password } = parsed.data;

      // Accept an email, a bare username, or the full `name#0417` handle.
      const [namePart, tagPart] = identifier.split('#');
      const lookupName = (namePart ?? identifier).toLowerCase();

      const candidates = await db
        .select()
        .from(users)
        .where(
          or(
            eq(users.email, identifier.toLowerCase()),
            eq(users.usernameLower, lookupName),
          ),
        )
        .limit(10);

      const user = tagPart
        ? candidates.find((c) => c.discriminator === tagPart)
        : candidates[0];

      if (!user) {
        // Burn equivalent CPU so response time does not reveal whether the account exists.
        await fakeVerifyPassword(password);
        throw ApiError.invalidCredentials();
      }

      if (!(await verifyPassword(user.passwordHash, password))) {
        throw ApiError.invalidCredentials();
      }

      await db
        .update(users)
        .set({ lastSeenAt: Date.now() })
        .where(eq(users.id, user.id));

      const tokens = await issueSession(db, reply, request, user.id);
      return reply.send({ user: toSelfUser(user), ...tokens });
    },
  );

  /* -------------------------------------------------------------------- */
  /* Refresh                                                               */
  /* -------------------------------------------------------------------- */

  app.post(
    '/refresh',
    { config: { rateLimit: { max: 60, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const presented =
        request.cookies[REFRESH_COOKIE_NAME] ??
        (request.body as { refreshToken?: string } | undefined)?.refreshToken;

      if (!presented) throw ApiError.unauthorized('No refresh token supplied');

      const tokenHash = hashRefreshToken(presented);

      const [session] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.tokenHash, tokenHash))
        .limit(1);

      if (!session) {
        reply.clearCookie(REFRESH_COOKIE_NAME, clearedRefreshCookieOptions());
        throw ApiError.unauthorized('Your session is no longer valid');
      }

      if (session.revokedAt !== null) {
        /*
         * A revoked token was just replayed. Either an old tab raced a rotation, or a
         * stolen token is being used. We cannot tell which, so we assume the worst and
         * revoke every session for this account, forcing a fresh login everywhere.
         */
        await db
          .update(sessions)
          .set({ revokedAt: Date.now() })
          .where(and(eq(sessions.userId, session.userId), isNull(sessions.revokedAt)));

        request.log.warn(
          { userId: session.userId, sessionId: session.id },
          'revoked refresh token replayed -- all sessions terminated',
        );

        reply.clearCookie(REFRESH_COOKIE_NAME, clearedRefreshCookieOptions());
        throw ApiError.unauthorized('Your session was ended for security reasons');
      }

      if (session.expiresAt <= Date.now()) {
        reply.clearCookie(REFRESH_COOKIE_NAME, clearedRefreshCookieOptions());
        throw ApiError.unauthorized('Your session expired');
      }

      // Rotate: the presented token is consumed, a brand-new one is issued.
      await db
        .update(sessions)
        .set({ revokedAt: Date.now() })
        .where(eq(sessions.id, session.id));

      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, session.userId))
        .limit(1);

      if (!user) throw ApiError.unauthorized('Your account no longer exists');

      const tokens = await issueSession(db, reply, request, user.id);
      return reply.send({ user: toSelfUser(user), ...tokens });
    },
  );

  /* -------------------------------------------------------------------- */
  /* Logout                                                                */
  /* -------------------------------------------------------------------- */

  app.post('/logout', async (request, reply) => {
    const presented = request.cookies[REFRESH_COOKIE_NAME];
    if (presented) {
      await db
        .update(sessions)
        .set({ revokedAt: Date.now() })
        .where(eq(sessions.tokenHash, hashRefreshToken(presented)));
    }
    reply.clearCookie(REFRESH_COOKIE_NAME, clearedRefreshCookieOptions());
    return reply.send({ ok: true });
  });

  app.post(
    '/logout-all',
    { preHandler: app.authenticate },
    async (request, reply) => {
      await db
        .update(sessions)
        .set({ revokedAt: Date.now() })
        .where(and(eq(sessions.userId, request.user!.id), isNull(sessions.revokedAt)));

      reply.clearCookie(REFRESH_COOKIE_NAME, clearedRefreshCookieOptions());
      return reply.send({ ok: true });
    },
  );

  /* -------------------------------------------------------------------- */
  /* Current user & password change                                        */
  /* -------------------------------------------------------------------- */

  app.get('/me', { preHandler: app.authenticate }, async (request) => {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, request.user!.id))
      .limit(1);

    if (!user) throw ApiError.unauthorized();
    return { user: toSelfUser(user) };
  });

  app.patch(
    '/password',
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const parsed = changePasswordSchema.safeParse(request.body);
      if (!parsed.success) throw fromZodError(parsed.error);

      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, request.user!.id))
        .limit(1);

      if (!user) throw ApiError.unauthorized();

      if (!(await verifyPassword(user.passwordHash, parsed.data.currentPassword))) {
        throw ApiError.invalidCredentials('Your current password is incorrect');
      }

      await db
        .update(users)
        .set({
          passwordHash: await hashPassword(parsed.data.newPassword),
          updatedAt: Date.now(),
        })
        .where(eq(users.id, user.id));

      // Changing a password should end sessions elsewhere -- that is usually the whole
      // point of changing it. The current session survives so the user is not logged out
      // of the tab they are looking at.
      await db
        .update(sessions)
        .set({ revokedAt: Date.now() })
        .where(and(eq(sessions.userId, user.id), isNull(sessions.revokedAt)));

      const tokens = await issueSession(db, reply, request, user.id);
      return reply.send({ ok: true, ...tokens });
    },
  );

  /* -------------------------------------------------------------------- */
  /* Session list                                                          */
  /* -------------------------------------------------------------------- */

  app.get('/sessions', { preHandler: app.authenticate }, async (request) => {
    const rows = await db
      .select({
        id: sessions.id,
        userAgent: sessions.userAgent,
        ipAddress: sessions.ipAddress,
        createdAt: sessions.createdAt,
        expiresAt: sessions.expiresAt,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, request.user!.id),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, Date.now()),
        ),
      );

    return {
      sessions: rows.map((row) => ({
        ...row,
        current: row.id === request.user!.sessionId,
      })),
    };
  });

  app.get('/config', async () => ({
    allowRegistration: env.ALLOW_REGISTRATION,
    limits: {
      usernameMax: LIMITS.USERNAME_MAX,
      passwordMin: LIMITS.PASSWORD_MIN,
      messageMax: LIMITS.MESSAGE_MAX,
      uploadMaxBytes: LIMITS.MAX_UPLOAD_BYTES,
    },
  }));
}
