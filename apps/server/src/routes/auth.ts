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
 *   POST /api/auth/forgot-password  email a reset link
 *   POST /api/auth/reset-password   spend that link and set a new password
 *
 * Rate limits here are tighter than the global default because these are the endpoints
 * worth brute-forcing.
 */

import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  LIMITS,
} from '@rockscord/shared';
import { env } from '../env.js';
import { emailVerifications, passwordResets, sessions, users } from '../db/schema.js';
import {
  REFRESH_COOKIE_NAME,
  clearedRefreshCookieOptions,
  fakeVerifyPassword,
  generateRefreshToken,
  generateVerificationToken,
  hashPassword,
  hashRefreshToken,
  hashVerificationToken,
  refreshCookieOptions,
  signAccessToken,
  verifyPassword,
} from '../lib/auth.js';
import {
  emailVerificationRequired,
  getEmailDriver,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from '../lib/email/index.js';
import { verificationResultPage } from '../lib/email/templates.js';
import { ApiError, fromZodError } from '../lib/errors.js';
import { newDiscriminator, newId } from '../lib/ids.js';
import { sanitizeDisplayName } from '../lib/sanitize.js';
import { toSelfUser } from '../lib/serializers.js';
import type { Database } from '../db/index.js';
import type { UserRow } from '../db/schema.js';

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

/* -------------------------------------------------------------------------- */
/* Email verification                                                          */
/* -------------------------------------------------------------------------- */

const APP_NAME = 'RocksCord';

/** True when the configured transport can reach a real mailbox. */
function emailCanDeliver(): boolean {
  return getEmailDriver().canDeliver;
}

/** How long the resend button is refused, to stop the endpoint being used as a mail cannon. */
const RESEND_COOLDOWN_MS = 60_000;

function verificationLink(token: string): string {
  return `${env.PUBLIC_URL}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
}

/**
 * Mint a verification token for `user` and email the link.
 *
 * Any previously issued token is retired first. Without that, an address could be
 * confirmed by a link generated before the last change to it, and every "resend" would
 * widen the set of live credentials in someone's inbox rather than replacing it.
 *
 * Throws if the message could not be handed to the provider. Callers decide whether that
 * is fatal -- registration says no, an explicit resend says yes.
 */
async function issueVerification(db: Database, user: UserRow): Promise<void> {
  const token = generateVerificationToken();
  const timestamp = Date.now();

  await db
    .update(emailVerifications)
    .set({ consumedAt: timestamp })
    .where(
      and(eq(emailVerifications.userId, user.id), isNull(emailVerifications.consumedAt)),
    );

  await db.insert(emailVerifications).values({
    id: newId(),
    userId: user.id,
    email: user.email,
    tokenHash: hashVerificationToken(token),
    createdAt: timestamp,
    expiresAt: timestamp + env.EMAIL_VERIFICATION_TTL_SECONDS * 1000,
  });

  await sendVerificationEmail({
    to: user.email,
    name: user.displayName || user.username,
    link: verificationLink(token),
  });
}

/**
 * The reset form lives in the web client, not on the API.
 *
 * Unlike a verification link, which only has to be *followed*, this one has to collect a
 * new password -- so it points at a React route that posts back to `/reset-password`.
 */
function passwordResetLink(token: string): string {
  return `${env.PUBLIC_URL}/reset-password?token=${encodeURIComponent(token)}`;
}

/**
 * Mint a reset token for `user` and email the link.
 *
 * Outstanding tokens are retired first, for a sharper reason than in `issueVerification`:
 * each live token is a working credential for the account, so pressing the button twice
 * must replace the first link rather than leave two valid ones in an inbox.
 */
async function issuePasswordReset(db: Database, user: UserRow): Promise<void> {
  const token = generateVerificationToken();
  const timestamp = Date.now();

  await db
    .update(passwordResets)
    .set({ consumedAt: timestamp })
    .where(and(eq(passwordResets.userId, user.id), isNull(passwordResets.consumedAt)));

  await db.insert(passwordResets).values({
    id: newId(),
    userId: user.id,
    email: user.email,
    tokenHash: hashVerificationToken(token),
    createdAt: timestamp,
    expiresAt: timestamp + env.PASSWORD_RESET_TTL_SECONDS * 1000,
  });

  await sendPasswordResetEmail({
    to: user.email,
    name: user.displayName || user.username,
    link: passwordResetLink(token),
  });
}

/** True when a reset link was sent within the cooldown window. */
async function resetSentRecently(db: Database, userId: string): Promise<boolean> {
  const [latest] = await db
    .select({ createdAt: passwordResets.createdAt })
    .from(passwordResets)
    .where(eq(passwordResets.userId, userId))
    .orderBy(desc(passwordResets.createdAt))
    .limit(1);

  return latest !== undefined && Date.now() - latest.createdAt < RESEND_COOLDOWN_MS;
}

/** True when the account was sent a link within the cooldown window. */
async function verificationSentRecently(db: Database, userId: string): Promise<boolean> {
  const [latest] = await db
    .select({ createdAt: emailVerifications.createdAt })
    .from(emailVerifications)
    .where(eq(emailVerifications.userId, userId))
    .orderBy(desc(emailVerifications.createdAt))
    .limit(1);

  return latest !== undefined && Date.now() - latest.createdAt < RESEND_COOLDOWN_MS;
}

function resultPage(ok: boolean, heading: string, detail: string): string {
  return verificationResultPage({
    ok,
    heading,
    detail,
    appUrl: `${env.PUBLIC_URL}/login`,
    appName: APP_NAME,
  });
}

/**
 * Confirm an address from a token.
 *
 * Returns a rendered outcome rather than throwing, because both entry points -- the link
 * in the email and the JSON endpoint -- need to describe *which* way it failed.
 */
async function consumeVerificationToken(
  db: Database,
  rawToken: string,
): Promise<{ ok: boolean; code: string; heading: string; detail: string }> {
  const [record] = await db
    .select()
    .from(emailVerifications)
    .where(eq(emailVerifications.tokenHash, hashVerificationToken(rawToken)))
    .limit(1);

  if (!record) {
    return {
      ok: false,
      code: 'INVALID',
      heading: 'That link is not valid',
      detail:
        'It may have been mistyped, cut short by your email client, or replaced by a newer ' +
        'one. Request a fresh link from the sign-in screen.',
    };
  }

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, record.userId))
    .limit(1);

  if (!user) {
    return {
      ok: false,
      code: 'INVALID',
      heading: 'That link is not valid',
      detail: 'The account it belonged to no longer exists.',
    };
  }

  if (record.consumedAt !== null) {
    /*
     * A used token usually means the person clicked twice, or their mail provider
     * pre-fetched the link before they ever saw it (Outlook and several corporate filters
     * do this). If the address ended up verified, that is a success from where they are
     * standing -- reporting an error would be both alarming and untrue.
     */
    if (user.emailVerifiedAt !== null) {
      return {
        ok: true,
        code: 'ALREADY_VERIFIED',
        heading: 'Already confirmed',
        detail: `${user.email} is verified. You can sign in.`,
      };
    }
    return {
      ok: false,
      code: 'CONSUMED',
      heading: 'That link has already been used',
      detail: 'Request a fresh one from the sign-in screen.',
    };
  }

  if (record.expiresAt <= Date.now()) {
    return {
      ok: false,
      code: 'EXPIRED',
      heading: 'That link has expired',
      detail: 'Request a fresh one from the sign-in screen and it will arrive within a minute.',
    };
  }

  if (record.email !== user.email) {
    // The address changed after the link was sent, so this token proves nothing about
    // the address the account actually uses now.
    return {
      ok: false,
      code: 'STALE',
      heading: 'That link is out of date',
      detail: 'The email address on this account changed. Request a new link.',
    };
  }

  const timestamp = Date.now();
  await db
    .update(emailVerifications)
    .set({ consumedAt: timestamp })
    .where(eq(emailVerifications.id, record.id));
  await db
    .update(users)
    .set({ emailVerifiedAt: timestamp, updatedAt: timestamp })
    .where(eq(users.id, user.id));

  return {
    ok: true,
    code: 'VERIFIED',
    heading: 'Email confirmed',
    detail: `${user.email} is verified. You can sign in now.`,
  };
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
      const mustVerify = emailVerificationRequired();

      await db.insert(users).values({
        id: userId,
        email,
        username,
        usernameLower,
        discriminator,
        displayName,
        passwordHash,
        status: 'online',
        // With no way to deliver a link there is nothing to confirm, so the account is
        // treated as verified rather than left in a state it could never leave.
        emailVerifiedAt: mustVerify ? null : timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastSeenAt: timestamp,
      });

      const [created] = await db.select().from(users).where(eq(users.id, userId)).limit(1);

      request.log.info({ userId, username: `${username}#${discriminator}` }, 'user registered');

      if (!mustVerify) {
        const tokens = await issueSession(db, reply, request, userId);
        return reply.status(201).send({ user: toSelfUser(created!), ...tokens });
      }

      /*
       * No session is issued: the whole point is that the address is unproven. The client
       * shows a "check your inbox" screen from `verificationRequired`.
       */
      let emailSent = true;
      try {
        await issueVerification(db, created!);
      } catch (error) {
        /*
         * A provider outage must not cost someone their account -- it exists, the password
         * is stored, and the resend button on the next screen will retry. The operator
         * needs to see this, so it is logged at error level with the provider's own
         * explanation, which is usually a misconfigured sender.
         */
        emailSent = false;
        request.log.error({ err: error, userId }, 'could not send verification email');
      }

      /*
       * `emailSent` is reported rather than swallowed. Without it the screen tells someone
       * to check an inbox that will never receive anything, and they spend their time
       * searching a spam folder for a message that was never accepted.
       */
      return reply.status(201).send({ verificationRequired: true, email, emailSent });
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

      /*
       * A deleted account keeps its row so old messages still render, but it is not an
       * account any more. Its stored hash cannot match any password, so this is belt and
       * braces -- and it keeps the reason explicit rather than looking like a typo.
       */
      if (user.deletedAt !== null) throw ApiError.invalidCredentials();

      if (user.emailVerifiedAt === null && emailVerificationRequired()) {
        /*
         * Checked only after the password verifies, so this never becomes an oracle for
         * which addresses are registered. By this point the caller has already proved they
         * own the account, so echoing the address back is safe -- and it lets the client
         * offer a resend to someone who signed in with their username and may not recall
         * which address they used.
         *
         * Sent rather than thrown because `details` carries per-field validation messages
         * and this is not one; overloading it would put an email address where the form
         * expects an error string.
         */
        return reply.status(403).send({
          error: {
            code: 'EMAIL_NOT_VERIFIED',
            message: 'Confirm your email address before signing in',
            email: user.email,
          },
        });
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
          // Invalidates access tokens already held by the other devices, which revoking
          // their sessions alone would not do for another fifteen minutes.
          passwordChangedAt: Date.now(),
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

  /* -------------------------------------------------------------------- */
  /* Email verification                                                    */
  /* -------------------------------------------------------------------- */

  /**
   * The target of the link in the email.
   *
   * A GET that changes state is a deliberate concession: a mail client can only offer a
   * link, and demanding a form submission instead would break the flow for everyone to
   * defend against a request no attacker can forge, since the token is the secret.
   */
  app.get(
    '/verify-email',
    { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const token = (request.query as { token?: string } | undefined)?.token;

      const outcome =
        typeof token === 'string' && token.length >= 20
          ? await consumeVerificationToken(db, token)
          : {
              ok: false,
              code: 'INVALID',
              heading: 'That link is not valid',
              detail: 'It is missing its confirmation code. Try copying the full address.',
            };

      if (outcome.ok) {
        request.log.info({ code: outcome.code }, 'email verified');
      }

      return reply
        .status(outcome.ok ? 200 : 400)
        .type('text/html; charset=utf-8')
        // Nothing about a one-time link should be cached, by the browser or anything between.
        .header('Cache-Control', 'no-store')
        .header('Referrer-Policy', 'no-referrer')
        .header('X-Content-Type-Options', 'nosniff')
        .send(resultPage(outcome.ok, outcome.heading, outcome.detail));
    },
  );

  /** The same operation as JSON, for clients that would rather not follow a redirect. */
  app.post(
    '/verify-email',
    { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const parsed = verifyEmailSchema.safeParse(request.body);
      if (!parsed.success) throw fromZodError(parsed.error);

      const outcome = await consumeVerificationToken(db, parsed.data.token);
      if (!outcome.ok) {
        throw new ApiError(400, 'BAD_REQUEST', outcome.detail);
      }
      return reply.send({ verified: true, alreadyVerified: outcome.code === 'ALREADY_VERIFIED' });
    },
  );

  /**
   * Send another link.
   *
   * Always answers the same way, whether the address is unknown, already verified, or
   * merely inside the cooldown. Anything else turns this into a way to test whether an
   * address has an account, which is exactly what login goes to some trouble to avoid.
   */
  app.post(
    '/resend-verification',
    /*
     * Deliberately looser than login. A request here is refused rather than acted on far
     * more often than it is honoured -- the address may be unknown, already verified, or
     * inside its cooldown -- and each of those still consumes a slot. Five was tight
     * enough that ordinary troubleshooting exhausted it, which reads as the feature being
     * broken. The 60-second cooldown, not this, is what actually bounds mail volume.
     */
    { config: { rateLimit: { max: 15, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const parsed = resendVerificationSchema.safeParse(request.body);
      if (!parsed.success) throw fromZodError(parsed.error);

      const uniform = {
        ok: true,
        message: 'If that address needs confirming, a new link is on its way.',
        cooldownSeconds: Math.round(RESEND_COOLDOWN_MS / 1000),
      };

      if (!emailVerificationRequired()) return reply.send(uniform);

      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.email, parsed.data.email))
        .limit(1);

      if (!user || user.emailVerifiedAt !== null) return reply.send(uniform);
      if (await verificationSentRecently(db, user.id)) return reply.send(uniform);

      try {
        await issueVerification(db, user);
      } catch (error) {
        /*
         * Unlike registration, this failure is worth reporting. The user pressed a button
         * and is now waiting for mail that will never arrive; leaving them to guess is
         * worse than admitting the send failed. The provider's own message stays in the
         * log -- it names the account, which the response must not.
         */
        request.log.error({ err: error, userId: user.id }, 'could not resend verification email');
        throw new ApiError(
          502,
          'INTERNAL_ERROR',
          'The email could not be sent right now. Try again in a few minutes.',
        );
      }

      return reply.send(uniform);
    },
  );

  /* -------------------------------------------------------------------- */
  /* Password reset                                                        */
  /* -------------------------------------------------------------------- */

  /**
   * Ask for a reset link.
   *
   * Answers identically for an address with an account and one without. That uniformity
   * is the whole security posture of this endpoint: it is unauthenticated and takes an
   * email, so any difference in reply -- wording, status, or noticeably faster timing --
   * turns it into a way to test whether someone has an account here.
   *
   * A failure to send is therefore *not* reported, which is the opposite of the choice
   * made for "resend verification". There, the address is already known to exist because
   * the user just registered it, so admitting the failure tells the user nothing they did
   * not know. Here it would.
   */
  app.post(
    '/forgot-password',
    /*
     * Tighter than the resend endpoint. Each honoured request sends mail to an address
     * chosen by whoever called it, so this is the one route where the rate limit is what
     * stops the server being used to post unwanted mail at a third party.
     */
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const parsed = forgotPasswordSchema.safeParse(request.body);
      if (!parsed.success) throw fromZodError(parsed.error);

      const uniform = {
        ok: true,
        message: 'If an account uses that address, a reset link is on its way.',
      };

      /*
       * Without a transport there is nothing to send and no link to click, so saying
       * "check your inbox" would leave someone waiting on mail that cannot arrive. The
       * console driver still prints the link, which is what makes this testable locally.
       */
      if (!emailCanDeliver() && env.isProduction) return reply.send(uniform);

      const [user] = await db
        .select()
        .from(users)
        .where(and(eq(users.email, parsed.data.email), isNull(users.deletedAt)))
        .limit(1);

      if (!user) return reply.send(uniform);
      if (await resetSentRecently(db, user.id)) return reply.send(uniform);

      try {
        await issuePasswordReset(db, user);
      } catch (error) {
        // Logged, never surfaced: see the note above on why this reply cannot vary.
        request.log.error({ err: error, userId: user.id }, 'could not send password reset email');
      }

      return reply.send(uniform);
    },
  );

  /**
   * Complete a reset.
   *
   * The token replaces the current password as proof, so everything that makes it safe
   * lives in how the row is checked: unexpired, unconsumed, and still matching the
   * address it was sent to. It is marked consumed in the same step that changes the
   * password, so a link cannot be replayed out of a mail archive.
   */
  app.post(
    '/reset-password',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const parsed = resetPasswordSchema.safeParse(request.body);
      if (!parsed.success) throw fromZodError(parsed.error);

      const now = Date.now();

      const [record] = await db
        .select()
        .from(passwordResets)
        .where(eq(passwordResets.tokenHash, hashVerificationToken(parsed.data.token)))
        .limit(1);

      /*
       * One message for every way a token can be unusable -- unknown, expired, already
       * used. They are the same situation from the user's side ("this link no longer
       * works, ask for another"), and distinguishing them would confirm to someone
       * holding a stolen token which of those it is.
       */
      const invalid = () =>
        new ApiError(
          400,
          'INVALID_TOKEN',
          'This reset link is no longer valid. Ask for a new one.',
        );

      if (!record || record.consumedAt !== null || record.expiresAt < now) throw invalid();

      const [user] = await db
        .select()
        .from(users)
        .where(and(eq(users.id, record.userId), isNull(users.deletedAt)))
        .limit(1);

      // The address must still be the one the link was sent to. Otherwise a token sitting
      // in an old inbox would keep working after the account moved away from it.
      if (!user || user.email !== record.email) throw invalid();

      await db
        .update(passwordResets)
        .set({ consumedAt: now })
        .where(eq(passwordResets.id, record.id));

      await db
        .update(users)
        .set({
          passwordHash: await hashPassword(parsed.data.newPassword),
          passwordChangedAt: now,
          /*
           * Reaching the link proves the address works, so an account that was still
           * unverified becomes verified here. Requiring a second round of mail to prove
           * the same mailbox twice would strand people who reset before confirming.
           */
          emailVerifiedAt: user.emailVerifiedAt ?? now,
          updatedAt: now,
        })
        .where(eq(users.id, user.id));

      /*
       * Every session, with no survivor -- unlike a password change made from inside the
       * app. Someone resetting has usually lost control of the password, and possibly of
       * a signed-in device; the request that gets here is an anonymous form post, not a
       * session worth preserving.
       */
      await db
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.userId, user.id), isNull(sessions.revokedAt)));

      // Retire any other outstanding links, so a second email cannot undo this one.
      await db
        .update(passwordResets)
        .set({ consumedAt: now })
        .where(and(eq(passwordResets.userId, user.id), isNull(passwordResets.consumedAt)));

      return reply.send({
        ok: true,
        message: 'Your password has been changed. Sign in with it.',
      });
    },
  );

  app.get('/config', async () => ({
    allowRegistration: env.ALLOW_REGISTRATION,
    requireEmailVerification: emailVerificationRequired(),
    /*
     * Whether a transport that can actually deliver is configured.
     *
     * Separate from `requireEmailVerification` on purpose, because the two failures look
     * identical from outside and have opposite fixes: a missing provider is a credentials
     * problem, a provider present with the switch off is a one-variable problem. Making
     * verification an explicit switch removed the accidental signal that used to
     * distinguish them, so this restores it deliberately. It reveals no secret -- only
     * that the server is capable of sending mail.
     */
    emailConfigured: emailCanDeliver(),
    limits: {
      usernameMax: LIMITS.USERNAME_MAX,
      passwordMin: LIMITS.PASSWORD_MIN,
      messageMax: LIMITS.MESSAGE_MAX,
      uploadMaxBytes: LIMITS.MAX_UPLOAD_BYTES,
    },
  }));
}
