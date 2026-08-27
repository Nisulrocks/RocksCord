/**
 * Database connection.
 *
 * One driver (`@libsql/client`) serves three very different environments, which is the
 * single decision that keeps this project genuinely free to run:
 *
 *   file:./data/rockscord.db      local development and the packaged desktop app (no install)
 *   file:<tmp>/rockscord-test-*   the test suite (a throwaway file per test file)
 *   libsql://...turso.io       the hosted free tier in production
 *
 * `:memory:` is not an option: this driver gives every connection its own private
 * in-memory database, so a transaction would run against an empty schema.
 *
 * All three speak identical SQL, so there is exactly one schema and one set of migrations.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { sql } from 'drizzle-orm';
import { env } from '../env.js';
import * as schema from './schema.js';

export type Database = LibSQLDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  client: Client;
  close: () => Promise<void>;
}

/** Turn `file:/c/path/to.db` into the directory that must exist before opening it. */
function ensureParentDirectory(url: string): void {
  if (!url.startsWith('file:')) return;
  const filePath = url.slice('file:'.length);
  if (!filePath) return;
  mkdirSync(path.dirname(filePath), { recursive: true });
}

/**
 * Apply connection PRAGMAs. These are per-connection settings, not stored in the file,
 * so they must be issued every time a connection is opened.
 *
 * Remote Turso connections ignore these (the server manages its own configuration), and
 * issuing them there would fail, so they are applied only to embedded databases.
 */
async function applyPragmas(client: Client, url: string): Promise<void> {
  const isEmbedded = url.startsWith('file:');
  if (!isEmbedded) return;

  // Referential integrity is off by default in SQLite. Without this, every ON DELETE
  // CASCADE in the schema would be decorative.
  await client.execute('PRAGMA foreign_keys = ON');

  {
    // WAL lets readers proceed during writes -- important when the HTTP handlers and the
    // socket gateway hit the same file concurrently.
    await client.execute('PRAGMA journal_mode = WAL');
    // NORMAL is the standard durability/throughput trade-off for WAL mode.
    await client.execute('PRAGMA synchronous = NORMAL');
    // Wait rather than immediately failing with SQLITE_BUSY under write contention.
    await client.execute('PRAGMA busy_timeout = 5000');
  }
}

/**
 * Create an isolated database handle. Tests call this directly to get a private
 * in-memory database; the app uses the shared `getDb()` singleton below.
 */
export async function createDb(
  url: string = env.DATABASE_URL,
  authToken: string | undefined = env.DATABASE_AUTH_TOKEN,
): Promise<DbHandle> {
  ensureParentDirectory(url);

  const client = createClient({ url, authToken });
  await applyPragmas(client, url);

  const db = drizzle(client, { schema, logger: false });

  return {
    db,
    client,
    close: async () => {
      client.close();
    },
  };
}

let handle: DbHandle | null = null;

/** Lazily open (and memoise) the process-wide database connection. */
export async function getDb(): Promise<DbHandle> {
  if (!handle) handle = await createDb();
  return handle;
}

export async function closeDb(): Promise<void> {
  if (handle) {
    await handle.close();
    handle = null;
  }
}

/** Cheap liveness probe used by the `/health` endpoint. */
export async function pingDb(db: Database): Promise<boolean> {
  try {
    await db.run(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}

export { schema };
