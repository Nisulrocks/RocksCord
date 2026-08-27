/**
 * CLI entry point for `npm run db:migrate`.
 *
 * Kept separate from `migrate.ts` deliberately. That module is imported by the app (and
 * therefore bundled into the desktop build), and a module that runs a script on import is
 * a landmine: when bundled, `import.meta.url` and `process.argv[1]` both point at the
 * bundle, so a "was I run directly?" check inside it fires and starts a second, racing
 * migration. A file that is only ever a script cannot have that problem.
 */

import { createDb } from './index.js';
import { runMigrations } from './migrate.js';
import { env } from '../env.js';

async function main(): Promise<void> {
  const handle = await createDb();
  try {
    console.log(`[db] migrating ${env.DATABASE_URL}`);
    await runMigrations(handle.db);
    console.log('[db] migrations applied');
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error('[db] migration failed:', error);
  process.exit(1);
});
