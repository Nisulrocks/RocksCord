import { defineConfig } from 'vitest/config';

/**
 * Test configuration.
 *
 * `pool: 'forks'` because each test file opens its own libSQL connection and native
 * modules are happier in separate processes than in worker threads.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 20000,
    hookTimeout: 30000,
    // Argon2 hashing makes auth tests inherently slow; running files in parallel keeps
    // the whole suite quick without weakening the hash parameters. Each file opens its
    // own temp-file database (see tests/helpers.ts), so there is nothing to contend on.
    fileParallelism: true,
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'test-only-secret-value-that-is-long-enough-to-pass',
      LOG_LEVEL: 'silent',
      SERVE_CLIENT: 'false',
      RATE_LIMIT_ENABLED: 'false',
    },
  },
});
