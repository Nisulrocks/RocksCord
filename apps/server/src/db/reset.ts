/**
 * Destructive database reset: `npm run db:reset`.
 *
 * Deletes the local database file (and uploaded files), then re-runs migrations and the
 * seed. Refuses to touch a remote Turso database -- wiping production because a script
 * name was ambiguous is not a recoverable mistake.
 */

import { rm } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../env.js';
import { createDb } from './index.js';
import { runMigrations } from './migrate.js';
import { seed } from './seed.js';

async function main(): Promise<void> {
  if (!env.DATABASE_URL.startsWith('file:')) {
    console.error(
      `[reset] Refusing to reset a non-local database (${env.DATABASE_URL}).\n` +
        '        Drop and recreate it from the Turso dashboard instead.',
    );
    process.exit(1);
  }

  const filePath = env.DATABASE_URL.slice('file:'.length);
  console.log(`[reset] deleting ${filePath}`);

  try {
    // WAL mode keeps two sidecar files; leaving them behind corrupts the fresh database.
    await rm(filePath, { force: true });
    await rm(`${filePath}-wal`, { force: true });
    await rm(`${filePath}-shm`, { force: true });
  } catch (error) {
    // Windows refuses to unlink a file another process still has open, and the raw
    // EBUSY is not obviously actionable.
    if ((error as NodeJS.ErrnoException).code === 'EBUSY') {
      console.error(
        [
          '',
          '[reset] The database is in use by another process.',
          '        Stop the dev server (Ctrl+C in its terminal) and close any running',
          '        RocksCord desktop app, then try again.',
          '',
        ].join('\n'),
      );
      process.exit(1);
    }
    throw error;
  }

  const uploadDir = path.resolve(env.UPLOAD_DIR);
  console.log(`[reset] clearing ${uploadDir}`);
  await rm(uploadDir, { recursive: true, force: true });

  const handle = await createDb();
  try {
    await runMigrations(handle.db);
    console.log('[reset] migrations applied');
    await seed(handle.db);
  } finally {
    await handle.close();
  }

  console.log('[reset] done');
}

main().catch((error) => {
  console.error('[reset] failed:', error);
  process.exit(1);
});
