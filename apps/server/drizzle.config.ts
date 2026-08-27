import { defineConfig } from 'drizzle-kit';
import 'dotenv/config';

/**
 * Drizzle Kit only ever needs to know the *shape* of the database to emit migrations.
 * Because local SQLite and hosted Turso speak the identical dialect, one config and one
 * set of generated .sql migrations serves both environments.
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'turso',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'file:../../data/rockscord.db',
    authToken: process.env.DATABASE_AUTH_TOKEN,
  },
  verbose: true,
  strict: true,
});
