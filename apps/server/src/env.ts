/**
 * Environment configuration.
 *
 * Design goal: the app must boot with an *empty* environment. Every variable has a
 * working default aimed at local development, so `npm run dev` and the packaged desktop
 * build need no configuration at all. Production overrides are opt-in.
 *
 * The one exception is `JWT_SECRET` in production: refusing to start without it is
 * deliberate, because silently falling back to a dev secret in a deployed app would be a
 * critical auth vulnerability.
 */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Walk upwards to find the monorepo root (the directory holding the workspace root package.json). */
function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'apps'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const REPO_ROOT = findRepoRoot(here);

// Load .env from the repo root first, then any local override next to the server.
dotenv.config({ path: path.join(REPO_ROOT, '.env'), quiet: true });
dotenv.config({ path: path.join(REPO_ROOT, 'apps', 'server', '.env'), quiet: true });

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()),
  );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65535).default(4000),

  /**
   * libSQL connection string.
   *   file:./data/rockscord.db      -> local file (default, zero setup)
   *   libsql://your-db.turso.io  -> hosted Turso, needs DATABASE_AUTH_TOKEN
   *
   * Note: `:memory:` is deliberately NOT supported. `@libsql/client` gives every
   * connection its own private in-memory database, so a transaction (which opens a
   * second connection) sees an empty schema. Tests use throwaway *files* instead.
   */
  DATABASE_URL: z.string().default(''),
  DATABASE_AUTH_TOKEN: z.string().optional(),

  /** HMAC key for signing access tokens. Auto-generated in dev, required in production. */
  JWT_SECRET: z.string().default(''),
  /** Access tokens are short-lived because they cannot be revoked before expiry. */
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(60 * 15),
  /** Refresh tokens are long-lived but revocable, rotated on every use. */
  REFRESH_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(3600)
    .default(60 * 60 * 24 * 30),

  /** Comma-separated list of allowed browser origins, or "*" to allow any. */
  CORS_ORIGIN: z.string().default('*'),
  /** Set true when serving over HTTPS so refresh cookies get the Secure flag. */
  COOKIE_SECURE: booleanish.default(false),
  COOKIE_DOMAIN: z.string().optional(),

  /** 'local' writes to disk; 'supabase' pushes to a Supabase Storage bucket. */
  STORAGE_DRIVER: z.enum(['local', 'supabase']).default('local'),
  UPLOAD_DIR: z.string().default(''),
  SUPABASE_URL: z.string().optional(),
  /** Service-role key. Server-side only -- never ship this to a client. */
  SUPABASE_SERVICE_KEY: z.string().optional(),
  SUPABASE_BUCKET: z.string().default('rockscord-uploads'),

  /** Absolute base URL of this server, used to build attachment URLs. */
  PUBLIC_URL: z.string().default(''),

  /** Serve the built web client from the API process (single-service deployment). */
  SERVE_CLIENT: booleanish.default(true),

  /** Master switch for rate limiting; disabled automatically under test. */
  RATE_LIMIT_ENABLED: booleanish.default(true),

  /** Optional TURN relay for WebRTC behind strict NATs. STUN alone is usually enough. */
  TURN_URL: z.string().optional(),
  TURN_USERNAME: z.string().optional(),
  TURN_CREDENTIAL: z.string().optional(),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  /** Allow open registration. Turn off to lock down a public deployment. */
  ALLOW_REGISTRATION: booleanish.default(true),
});

export type Env = z.infer<typeof schema> & {
  DATA_DIR: string;
  isProduction: boolean;
  isTest: boolean;
  corsOrigins: string[] | true;
};

function buildEnv(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const env = parsed.data;
  const isProduction = env.NODE_ENV === 'production';
  const isTest = env.NODE_ENV === 'test';

  const dataDir = path.join(REPO_ROOT, 'data');

  if (!env.DATABASE_URL) {
    env.DATABASE_URL = `file:${path.join(dataDir, 'rockscord.db').replace(/\\/g, '/')}`;
  }

  if (!env.UPLOAD_DIR) {
    env.UPLOAD_DIR = path.join(dataDir, 'uploads');
  }

  if (!env.JWT_SECRET) {
    if (isProduction) {
      throw new Error(
        'JWT_SECRET is required when NODE_ENV=production. ' +
          'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"',
      );
    }
    // Ephemeral dev secret: regenerating it on restart simply invalidates old tokens.
    env.JWT_SECRET = randomBytes(48).toString('base64url');
  }

  if (env.JWT_SECRET.length < 32 && isProduction) {
    throw new Error('JWT_SECRET must be at least 32 characters in production.');
  }

  if (!env.PUBLIC_URL) {
    const host = env.HOST === '0.0.0.0' ? 'localhost' : env.HOST;
    env.PUBLIC_URL = `http://${host}:${env.PORT}`;
  }
  env.PUBLIC_URL = env.PUBLIC_URL.replace(/\/+$/, '');

  if (env.STORAGE_DRIVER === 'supabase' && (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY)) {
    throw new Error(
      'STORAGE_DRIVER=supabase requires SUPABASE_URL and SUPABASE_SERVICE_KEY to be set.',
    );
  }

  const corsOrigins: string[] | true =
    env.CORS_ORIGIN.trim() === '*'
      ? true
      : env.CORS_ORIGIN.split(',')
          .map((s) => s.trim())
          .filter(Boolean);

  return {
    ...env,
    DATA_DIR: dataDir,
    isProduction,
    isTest,
    corsOrigins,
    RATE_LIMIT_ENABLED: isTest ? false : env.RATE_LIMIT_ENABLED,
  };
}

export const env: Env = buildEnv();

/** Rebuild config from the current `process.env`. Used by tests that mutate the env. */
export function reloadEnv(): Env {
  return buildEnv();
}
