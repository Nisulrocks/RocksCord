/**
 * Migration runner.
 *
 * Migrations run automatically on every boot rather than being a separate step the user
 * has to remember. Drizzle records applied migrations in `__drizzle_migrations`, so this
 * is idempotent and costs one indexed read once the database is up to date.
 *
 * After the generated migrations, a small hand-written step creates the FTS5 full-text
 * index. Drizzle Kit has no schema syntax for virtual tables, and expressing it here as
 * an idempotent `CREATE ... IF NOT EXISTS` block is more robust than hand-editing
 * generated migration files (which Drizzle would then re-diff on the next generate).
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { sql } from 'drizzle-orm';
import { REPO_ROOT } from '../env.js';
import type { Database } from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Locate the generated migrations folder. The candidates cover: running from source via
 * tsx, running the compiled `dist/` output, and running inside a packaged Electron app
 * where the folder is copied next to the app resources.
 */
export function resolveMigrationsFolder(): string {
  const candidates = [
    path.join(REPO_ROOT, 'apps', 'server', 'drizzle'),
    path.resolve(here, '..', '..', 'drizzle'),
    path.resolve(here, '..', '..', '..', 'drizzle'),
    ...(process.resourcesPath
      ? [
          path.join(process.resourcesPath, 'drizzle'),
          path.join(process.resourcesPath, 'app', 'drizzle'),
        ]
      : []),
  ];

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'meta', '_journal.json'))) return candidate;
  }

  throw new Error(
    `Could not find the Drizzle migrations folder. Looked in:\n${candidates
      .map((c) => `  - ${c}`)
      .join('\n')}\nRun \`npm run db:generate\` to create it.`,
  );
}

/**
 * Full-text search index over message content.
 *
 * This is an *external content* FTS5 table: it stores only the inverted index and reads
 * the actual text from `messages` via rowid, so message bodies are not duplicated. The
 * three triggers keep it in sync with inserts, edits, and deletes.
 */
const FTS_STATEMENTS = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
     content,
     content='messages',
     content_rowid='rowid',
     tokenize='unicode61 remove_diacritics 2'
   )`,
  `CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
     INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
   END`,
  `CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
     INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
   END`,
  `CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF content ON messages BEGIN
     INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
     INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
   END`,
];

/**
 * True when the FTS index exists and is usable. The search route falls back to a LIKE
 * scan when this is false, so a build of SQLite without FTS5 degrades rather than breaks.
 */
export let ftsAvailable = false;

async function setupFullTextSearch(db: Database): Promise<void> {
  try {
    for (const statement of FTS_STATEMENTS) {
      await db.run(sql.raw(statement));
    }
    ftsAvailable = true;
  } catch (error) {
    ftsAvailable = false;
    // Not fatal: search still works via LIKE, just without ranking.
    console.warn(
      '[db] FTS5 unavailable, message search will fall back to LIKE matching:',
      error instanceof Error ? error.message : error,
    );
  }
}

/** Run all pending migrations plus the FTS setup against an existing connection. */
export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: resolveMigrationsFolder() });
  await setupFullTextSearch(db);
}
