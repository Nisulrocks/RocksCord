/**
 * Authentication primitives: password hashing, access tokens, refresh tokens.
 *
 * The token model is a standard split:
 *
 *   Access token   JWT, HS256, 15 min, sent as `Authorization: Bearer`. Stateless, so
 *                  every request validates without a database round trip. It cannot be
 *                  revoked, which is exactly why it is short-lived.
 *
 *   Refresh token  256 bits of raw entropy (not a JWT -- there is nothing to encode).
 *                  Delivered in an httpOnly + SameSite cookie so page JavaScript, and
 *                  therefore any XSS, cannot read it. Only a SHA-256 hash is stored, so
 *                  a database dump is not a set of usable credentials.
 *
 * Refresh tokens rotate on every use: redeeming one revokes it and issues a new one. If a
 * stolen token is redeemed after the legitimate client already rotated, the presented
 * token hashes to a revoked row -- which is a detectable theft signal, and we respond by
 * revoking the whole session family.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { env } from '../env.js';

/**
 * Argon2id parameters.
 *
 * 19 MiB / 2 passes / 1 lane is the configuration OWASP recommends as a minimum for
 * Argon2id. It costs ~15 ms per hash on a typical laptop: slow enough to make offline
 * cracking expensive, fast enough that a login request is not noticeably delayed and a
 * burst of logins cannot exhaust a 512 MB free-tier container.
 */
// `Algorithm.Argon2id` is an ambient const enum, which cannot be read at runtime under
// `verbatimModuleSyntax`. 2 is its value, fixed by the library's public API.
const ARGON2ID = 2;

const ARGON_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plaintext: string): Promise<string> {
  return argonHash(plaintext, ARGON_OPTIONS);
}

/**
 * Verify a password. Returns false rather than throwing on a malformed hash, so a
 * corrupted row is a failed login rather than a 500.
 */
export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  try {
    return await argonVerify(hash, plaintext);
  } catch {
    return false;
  }
}

/**
 * Burn roughly the same CPU as a real verification when the user does not exist.
 * Without this, "no such user" returns in ~0 ms while "wrong password" takes ~15 ms,
 * and that gap is enough to enumerate which accounts exist.
 */
// A real Argon2id hash of an unknown throwaway string, so verification does the full
// amount of work. A syntactically invalid hash would be rejected instantly and defeat
// the entire purpose.
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$Yyt+WUfXjkk3mbmN13bOdA$+FZv/JLr/mqlC4s+ekoekAgw1cHWc2xblmiKLAnk4dM';

export async function fakeVerifyPassword(plaintext: string): Promise<void> {
  await verifyPassword(DUMMY_HASH, plaintext);
}

/* -------------------------------------------------------------------------- */
/* Access tokens                                                               */
/* -------------------------------------------------------------------------- */

export interface AccessTokenClaims extends JWTPayload {
  /** User id. */
  sub: string;
  /** Session id, so a refreshed access token can be tied back to its session row. */
  sid: string;
}

const encoder = new TextEncoder();
const secretKey = () => encoder.encode(env.JWT_SECRET);

const ISSUER = 'rockscord';
const AUDIENCE = 'rockscord-client';

export async function signAccessToken(userId: string, sessionId: string): Promise<string> {
  return new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(secretKey());
}

/** Verify and decode an access token. Returns null for anything invalid or expired. */
export async function verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
    return payload as AccessTokenClaims;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Refresh tokens                                                              */
/* -------------------------------------------------------------------------- */

/** 256 bits of entropy, base64url encoded. Returned to the client exactly once. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Hash a refresh token for storage and lookup.
 *
 * SHA-256 rather than Argon2 is the right call here: the token is already 256 bits of
 * uniform randomness, so there is no low-entropy guess space for a slow hash to defend.
 * A fast hash keeps the token-lookup index usable.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time comparison for any secret compared outside the database. */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/* -------------------------------------------------------------------------- */
/* Cookies                                                                     */
/* -------------------------------------------------------------------------- */

export const REFRESH_COOKIE_NAME = 'rockscord_refresh';

/**
 * Cookie attributes for the refresh token.
 *
 * `sameSite: 'lax'` blocks the cookie on cross-site POSTs, which is what makes CSRF
 * against the refresh endpoint a non-issue; the API itself never authenticates a mutation
 * from a cookie alone (mutations require the Bearer access token), so this is defence in
 * depth rather than the only line.
 *
 * When the API and web client are deployed to different origins, `COOKIE_SECURE=true`
 * plus `sameSite: 'none'` is required -- hence the conditional.
 */
export function refreshCookieOptions() {
  const secure = env.COOKIE_SECURE;
  return {
    httpOnly: true,
    secure,
    sameSite: (secure ? 'none' : 'lax') as 'none' | 'lax',
    path: '/',
    domain: env.COOKIE_DOMAIN,
    maxAge: env.REFRESH_TOKEN_TTL_SECONDS,
  };
}

export function clearedRefreshCookieOptions() {
  return { ...refreshCookieOptions(), maxAge: 0 };
}
