import { defineConfig } from 'drizzle-kit'

/**
 * drizzle-kit configuration — schema in, forward-only SQL out.
 *
 * `generate` is the only command this repository uses drizzle-kit for; applying migrations goes
 * through `src/db/migrations/run-migrations.ts` so the forward-only rule and the connection
 * handling live in reviewed application code rather than in a CLI flag. `push` and `drop` are
 * deliberately never run: both mutate a database without leaving a migration behind.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  casing: 'snake_case',
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.SISYPHUS_DATABASE_URL ?? '',
  },
})
