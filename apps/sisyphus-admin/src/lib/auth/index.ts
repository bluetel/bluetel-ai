import NextAuth from 'next-auth'

import { createAuthConfig } from './config'

/**
 * The panel's auth entry point (FR-011).
 *
 * `handlers` is mounted by `src/app/api/auth/[...nextauth]/route.ts`; `auth()` resolves the
 * database-backed session for a server component, a route handler or the tRPC context.
 *
 * The config is passed as a **thunk**. Auth.js evaluates it per request, which keeps the database
 * pool and the OAuth secrets out of module evaluation — otherwise `next build`'s page-data
 * collection, which imports every route module, would need a live database and real credentials to
 * build a route it never calls.
 */
export const { handlers, auth, signIn, signOut } = NextAuth(() => createAuthConfig())

export { createSisyphusAdapter } from './adapter'
export type { SisyphusAdapterOptions } from './adapter'
export { getAuthDatabase } from './database'
export { createAuthConfig } from './config'
export {
  describeDomainRejection,
  normalisePermittedDomain,
  toPermittedDomainSet,
  verifyPermittedDomain,
} from './permitted-domains'
export type { DomainRejectionReason, DomainVerdict, GoogleIdTokenClaims } from './permitted-domains'
export { isActiveSessionUser, isAdminSessionUser, toSessionUser } from './session-user'
export type { SessionUserRow, SisyphusSessionUser } from './session-user'
export { decideSignIn } from './sign-in-decision'
export type {
  ExistingUserFacts,
  SignInDecision,
  SignInDecisionInput,
  SignInRefusal,
} from './sign-in-decision'
