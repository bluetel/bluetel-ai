import type { SisyphusDependencies } from '@bluetel-ai/sisyphus-api/server'
import { getAuthDatabase } from '@sisyphus-admin/lib/auth'

import { resolveNoMachineCredential } from './machine-credential'
import { recordDenial } from './record-denial'
import { resolveSisyphusSession } from './resolve-session'

/**
 * Everything `sisyphus-api` needs from the panel, assembled per request.
 *
 * The package reads no environment and imports no Auth.js: it declares four dependencies and the
 * host supplies them. This function is the panel's supply, and it is a **function** rather than a
 * module-level constant for the same reason `createAuthConfig` is — `next build` imports every
 * route module while collecting page data, so a constant here would open a database pool and
 * require `DATABASE_URL` at build time for a route nobody is calling.
 *
 * `getAuthDatabase()` is memoised inside `sisyphus-api`, so calling it per request reuses the one
 * pool a warm container already holds rather than opening another.
 */
export const createSisyphusDependencies = (): SisyphusDependencies => ({
  db: getAuthDatabase(),
  resolveSession: resolveSisyphusSession,
  resolveMachineCredential: resolveNoMachineCredential,
  recordDenial,
})
