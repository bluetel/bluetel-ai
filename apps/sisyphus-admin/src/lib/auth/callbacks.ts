import type { GoogleIdTokenClaims } from './permitted-domains'
import { describeDomainRejection } from './permitted-domains'
import type { SessionUserRow, SisyphusSessionUser } from './session-user'
import { toSessionUser } from './session-user'
import type { ExistingUserFacts } from './sign-in-decision'
import { decideSignIn } from './sign-in-decision'

/**
 * The two Auth.js callbacks that carry policy, built as factories over their dependencies.
 *
 * They are separated from `config.ts` and injected rather than imported so the gate can be
 * exercised directly. A domain check reachable only through a live OAuth round trip is a domain
 * check that gets tested once, by hand, and never again.
 */

export interface SignInCallbackDependencies {
  /** From `SISYPHUS_PERMITTED_EMAIL_DOMAINS` — the allowlist the `hd` claim is checked against. */
  readonly permittedDomains: readonly string[]
  /** Resolves the existing `users` row, or `undefined` on a first sign-in. */
  readonly findExistingUser: (email: string) => Promise<ExistingUserFacts | undefined>
  /** Where a refusal is recorded. Injected so the test can assert on it. */
  readonly warn: (message: string) => void
}

export interface SignInCallbackParameters {
  /**
   * The **verified** ID token payload. Auth.js fetches it from Google's token endpoint over a
   * server-to-server call and verifies it before any callback runs, so nothing reachable here was
   * supplied by the browser.
   */
  readonly profile?: GoogleIdTokenClaims | null
}

/**
 * Refuse or admit a sign-in (FR-011, FR-175, FR-176).
 *
 * The `users` lookup happens only after the claims are in hand and only when an address is
 * present, so an unknown caller from a domain we do not permit never causes a query.
 */
export const createSignInCallback =
  ({ permittedDomains, findExistingUser, warn }: SignInCallbackDependencies) =>
  async ({ profile }: SignInCallbackParameters): Promise<boolean> => {
    const claims: GoogleIdTokenClaims = profile ?? {}
    const email = typeof claims.email === 'string' ? claims.email.trim() : ''

    const decision = decideSignIn({
      claims,
      permittedDomains,
      existingUser: email === '' ? undefined : await findExistingUser(email),
    })

    if (!decision.allowed) {
      // A refusal is logged as a reason and never with the address that was offered: this is an
      // access-control event, not a place to record who tried.
      warn(
        decision.refusal.kind === 'domain'
          ? describeDomainRejection(decision.refusal.reason)
          : 'Sign-in refused: the account is deactivated (FR-176).',
      )
      return false
    }

    // T037 seam — `decision.isFirstSignIn` is true for an account with no `users` row. Creating
    // that row as `engineer` (FR-170) belongs to T037, which supplies a `createUser` through
    // `createSisyphusAdapter({ createUser })` and implements it in `src/lib/auth/on-sign-in.ts`.
    // Nothing here creates a user, so today a first sign-in fails at the adapter rather than
    // silently producing a half-populated row.
    return true
  }

export interface SessionCallbackParameters<TSession> {
  readonly session: TSession
  /**
   * The `users` row the session token resolves to, re-read on **this** request because the session
   * strategy is `database` rather than `jwt` (FR-175).
   */
  readonly user: SessionUserRow
}

/**
 * Project the freshly-read `users` row onto the session.
 *
 * This is what makes deactivation land at the next request: `role` and `isActive` on the session
 * are whatever the database says now, not what it said when the session was created.
 */
export const attachSessionUser = <TSession extends object>({
  session,
  user,
}: SessionCallbackParameters<TSession>): TSession & { user: SisyphusSessionUser } => ({
  ...session,
  user: { ...((session as { user?: object }).user ?? {}), ...toSessionUser(user) },
})
