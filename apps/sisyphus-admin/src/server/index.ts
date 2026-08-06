/**
 * The panel's server-only wiring: what `sisyphus-api` is handed, and who may render an admin page.
 *
 * Nothing here is safe in a browser bundle — the dependency factory reaches a database handle and
 * the gate reaches Auth.js. Consumers are route handlers and server components, and they import
 * this barrel rather than a module inside it.
 */

export { decideAdminPageAccess, SIGN_IN_PATH } from './admin-page-access'
export type { AdminPageAccess } from './admin-page-access'

export { createSisyphusDependencies } from './dependencies'

export {
  bearerTokenFrom,
  createScopedCredentialResolver,
  CREDENTIAL_HEADER,
  resolveNoMachineCredential,
  SCOPED_CREDENTIAL_AUDIENCE,
  SCOPED_CREDENTIAL_ISSUER,
  verifyScopedCredential,
  workflowIdFromSubject,
} from './machine-credential'
export type { ScopedCredentialResolverOptions } from './machine-credential'

export { createMachineDependencies, resolveNoSession } from './machine-dependencies'

export {
  createDenialRecorder,
  createLoggingDenialWriter,
  formatDenial,
  recordDenial,
} from './record-denial'
export type { DenialReporter, DenialWriter } from './record-denial'

export { requireAdminPage } from './require-admin-page'

export { resolveSisyphusSession } from './resolve-session'

export { toSisyphusSession } from './to-sisyphus-session'
export type { AuthSessionLike } from './to-sisyphus-session'
