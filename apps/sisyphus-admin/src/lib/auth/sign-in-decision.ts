import type { DomainRejectionReason, GoogleIdTokenClaims } from './permitted-domains'
import { verifyPermittedDomain } from './permitted-domains'

/**
 * The sign-in gate, expressed as a pure decision so it is testable without an OAuth round trip.
 *
 * Two independent conditions have to hold, and they fail for different reasons:
 *
 * 1. The verified `hd` claim names a permitted Workspace domain (FR-011).
 * 2. The user, **if they already exist**, is active (FR-175, FR-176).
 *
 * The order matters. Domain first, because a stranger from a domain we do not permit must not be able
 * to learn whether an address exists in this platform by comparing refusal reasons.
 */

export type SignInRefusal =
  | { readonly kind: 'domain'; readonly reason: DomainRejectionReason }
  /** A known user whose access has been withdrawn. Deactivation is never deletion (FR-176). */
  | { readonly kind: 'deactivated' }

export type SignInDecision =
  | { readonly allowed: true; readonly domain: string; readonly isFirstSignIn: boolean }
  | { readonly allowed: false; readonly refusal: SignInRefusal }

/** What the gate needs to know about an existing `users` row. Nothing more. */
export interface ExistingUserFacts {
  readonly isActive: boolean
}

export interface SignInDecisionInput {
  /** The verified ID token payload. Never a client-supplied value. */
  readonly claims: GoogleIdTokenClaims
  readonly permittedDomains: readonly string[]
  /** `undefined` when no `users` row matches — first sign-in. */
  readonly existingUser: ExistingUserFacts | undefined
}

export const decideSignIn = ({
  claims,
  permittedDomains,
  existingUser,
}: SignInDecisionInput): SignInDecision => {
  const verdict = verifyPermittedDomain(claims, permittedDomains)
  if (!verdict.permitted) {
    return { allowed: false, refusal: { kind: 'domain', reason: verdict.reason } }
  }

  if (existingUser !== undefined && !existingUser.isActive) {
    return { allowed: false, refusal: { kind: 'deactivated' } }
  }

  return { allowed: true, domain: verdict.domain, isFirstSignIn: existingUser === undefined }
}
