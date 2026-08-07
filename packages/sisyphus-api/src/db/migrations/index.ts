/**
 * Migration tooling entry point — `@bluetel-ai/sisyphus-api/db/migrations`.
 *
 * Separate from `./db` on purpose. The runner locates its SQL relative to its own module URL, which
 * a bundler cannot resolve statically; anything that re-exports it forces every consumer of a table
 * definition to carry migration tooling too. Applications import `./db`; only the CLI and tests
 * import this.
 *
 * Migrations are forward-only (FR-010) — there are no `down` migrations to expose.
 */

export {
  assertForwardOnly,
  MIGRATIONS_FOLDER,
  MIGRATIONS_SCHEMA,
  MIGRATIONS_TABLE,
  readMigrationJournal,
  runMigrations,
} from './run-migrations'
export type { MigrationJournal, MigrationJournalEntry, MigrationReport } from './run-migrations'
