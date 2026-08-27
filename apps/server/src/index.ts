/**
 * Server entry point.
 *
 * Responsible only for process concerns: binding the port, scheduling background
 * maintenance, and shutting down cleanly. Everything else lives in `app.ts`, which is
 * also what the tests and the Electron desktop build boot.
 */

import { buildApp } from './app.js';
import { env } from './env.js';
import { sweepOrphanedAttachments } from './routes/files.js';

/** How often to sweep uploads that were never attached to a message. */
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function main(): Promise<void> {
  const { app, ctx, close } = await buildApp();

  await app.listen({ port: env.PORT, host: env.HOST });

  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : env.PORT;

  app.log.info(
    {
      port,
      host: env.HOST,
      database: env.DATABASE_URL.startsWith('libsql://') ? 'turso (remote)' : env.DATABASE_URL,
      storage: env.STORAGE_DRIVER,
      publicUrl: env.PUBLIC_URL,
    },
    'rockscord server listening',
  );

  if (!env.isProduction) {
    // Printed plainly (not through the logger) so it is easy to spot and click.
    console.log(`\n  Web client:  ${env.PUBLIC_URL}`);
    console.log(`  Health:      ${env.PUBLIC_URL}/health\n`);
  }

  const sweepTimer = setInterval(() => {
    sweepOrphanedAttachments(ctx.db)
      .then((count) => {
        if (count > 0) app.log.info({ count }, 'swept orphaned attachments');
      })
      .catch((error) => app.log.warn({ err: error }, 'attachment sweep failed'));
  }, SWEEP_INTERVAL_MS);

  // Never let a maintenance timer hold the process open during shutdown.
  sweepTimer.unref();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    clearInterval(sweepTimer);
    try {
      await close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'unhandled promise rejection');
  });
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
