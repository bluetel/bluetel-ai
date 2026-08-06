import type { SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'
import { getDatabaseClient } from '@bluetel-ai/sisyphus-api/db'
import { env } from '@sisyphus-admin/env'

/**
 * The panel's database handle.
 *
 * `getDatabaseClient` is memoised on the module, so a warm serverless container reuses one pool
 * across invocations rather than opening one per request — the connection ceiling is at the
 * database, not in this process.
 *
 * Deliberately a function rather than a module-level constant: reading `env.DATABASE_URL` at import
 * time would make every module that transitively imports auth require a validated environment,
 * including the ones a test only wants for their pure functions.
 */
export const getAuthDatabase = (): SisyphusDatabase =>
  getDatabaseClient({ connectionString: env.DATABASE_URL }).db
