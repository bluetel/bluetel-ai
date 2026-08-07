/**
 * Schema and migration entry point — `@bluetel-ai/sisyphus-api/db`.
 *
 * Not browser-safe: this subpath pulls in Drizzle and the `postgres` driver. Application code
 * reaches the database through `@bluetel-ai/sisyphus-api/server`, which owns the access scoping
 * (FR-190) that a raw handle would let a caller skip. Consumers import this barrel and never a
 * module underneath it.
 *
 * The package deliberately declares **no root `.` export**, so the only way in is one of the four
 * subpaths — which makes the FR-005 boundary a build-time fact rather than a review convention.
 */

export * from './client'
export * from './schema'
export { uuidV7, uuidV7TimestampMs } from './uuid-v7'

/**
 * The migration runner is **not** re-exported here. It lives behind its own `./db/migrations`
 * subpath, for the same reason the package has no root barrel: `run-migrations.ts` locates its SQL
 * with `new URL('.', import.meta.url)`, which a bundler cannot resolve statically, so re-exporting
 * it from this barrel drags migration tooling into every consumer that only wanted a table
 * definition — and breaks the panel's build the moment its Auth.js adapter imports a schema.
 *
 * Migrations are run by the CLI and by tests, never by an application at request time. Keeping the
 * two apart is the same boundary argument as the four subpaths, one level down.
 */

/**
 * Version of the applied schema. Migration tooling compares this against the version recorded in
 * the database and refuses to run when the deployed code is older than the database it points at.
 * `1` is the initial schema; every later migration increments it.
 */
export const SISYPHUS_SCHEMA_VERSION = 1

export type SisyphusSchemaVersion = typeof SISYPHUS_SCHEMA_VERSION
