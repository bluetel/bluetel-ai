/**
 * Server-side verification of the Google Workspace domain (FR-011).
 *
 * The value this checks is the `hd` claim of the ID token, which Auth.js obtains from Google's
 * token endpoint over a server-to-server call and verifies before it ever reaches a callback. That
 * is the whole point of checking `hd` rather than the email address: an email suffix is a string
 * anyone can produce, whereas `hd` is asserted by Google about a Workspace account and cannot be
 * set by the person signing in.
 *
 * Two near-misses this module deliberately refuses:
 *
 * - **Trusting the email suffix.** `alice@example.com` on a personal Google account carries no
 *   `hd` claim at all; accepting the suffix would let any consumer account claim the domain.
 * - **Suffix matching the domain.** `example.com.attacker.net` ends with nothing useful, but
 *   `not-example.com` ends with `example.com`. Comparison is against the whole label, never
 *   `endsWith`.
 *
 * Everything here is pure so it can be tested directly rather than through a live OAuth round
 * trip.
 */

/**
 * The subset of the verified ID token payload this check reads. Deliberately typed as `unknown`
 * per field: the payload arrives as JSON, and pretending it is already the right shape is how an
 * absent claim becomes an accidental pass.
 */
export interface GoogleIdTokenClaims {
  /** Google Workspace hosted domain. Absent on consumer accounts. */
  readonly hd?: unknown
  readonly email?: unknown
  readonly email_verified?: unknown
}

export type DomainRejectionReason =
  /** No `hd` claim — a personal Google account, not a Workspace one. */
  | 'missing-hd-claim'
  /** A Workspace account, but not one of ours. */
  | 'domain-not-permitted'
  /** Google has not verified the address on the account. */
  | 'email-not-verified'

export type DomainVerdict =
  | { readonly permitted: true; readonly domain: string }
  | { readonly permitted: false; readonly reason: DomainRejectionReason }

/**
 * Normalise a configured domain: lower-cased, trimmed, and tolerant of someone writing
 * `@example.com` in the environment variable, which is the obvious way to get it wrong.
 */
export const normalisePermittedDomain = (value: string): string =>
  value.trim().toLowerCase().replace(/^@/, '')

/** The configured allowlist as a set, so membership is an exact whole-label match. */
export const toPermittedDomainSet = (domains: readonly string[]): ReadonlySet<string> =>
  new Set(domains.map(normalisePermittedDomain).filter((domain) => domain.length > 0))

/**
 * Verify a set of ID token claims against the permitted-domain allowlist.
 *
 * Returns a verdict rather than throwing, so the caller decides what a rejection means — the
 * sign-in callback turns it into a refusal, and the tests assert on the reason.
 */
export const verifyPermittedDomain = (
  claims: GoogleIdTokenClaims,
  permittedDomains: readonly string[],
): DomainVerdict => {
  if (claims.email_verified !== true) {
    return { permitted: false, reason: 'email-not-verified' }
  }

  const hd = typeof claims.hd === 'string' ? claims.hd.trim().toLowerCase() : ''
  if (hd === '') {
    return { permitted: false, reason: 'missing-hd-claim' }
  }

  if (!toPermittedDomainSet(permittedDomains).has(hd)) {
    return { permitted: false, reason: 'domain-not-permitted' }
  }

  return { permitted: true, domain: hd }
}

/**
 * A message for the platform log. It names the reason and the domain that was offered but never
 * the address, because a sign-in refusal is an access-control event and not a place to record who
 * tried.
 */
export const describeDomainRejection = (reason: DomainRejectionReason): string => {
  switch (reason) {
    case 'missing-hd-claim':
      return 'Sign-in refused: the Google account carries no hosted-domain (hd) claim, so it is a personal account rather than a Workspace one.'
    case 'domain-not-permitted':
      return 'Sign-in refused: the verified Google Workspace domain is not in SISYPHUS_PERMITTED_EMAIL_DOMAINS.'
    case 'email-not-verified':
      return 'Sign-in refused: Google reports the address on this account as unverified.'
  }
}
