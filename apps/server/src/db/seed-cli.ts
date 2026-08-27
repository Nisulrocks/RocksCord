/**
 * CLI entry point for `npm run db:seed`.
 * See the note in `migrate-cli.ts` for why the script and the module are separate files.
 */

import { createDb } from './index.js';
import { runMigrations } from './migrate.js';
import { seed } from './seed.js';

async function main(): Promise<void> {
  const handle = await createDb();
  try {
    await runMigrations(handle.db);
    await seed(handle.db);
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error('[seed] failed:', error);
  process.exit(1);
});
