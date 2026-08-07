import type { SignInRefusal } from '@sisyphus-admin/lib/auth'

/**
 * The `error` query parameter, turned into something an operator can read (T147, FR-195).
 *
 * ## What actually arrives here
 *
 * `pages.error` in `src/lib/auth/config.ts` is `/sign-in`, and `@auth/core` builds that return as
 * `?error=<AuthError.type>` — `AccessDenied`, `Configuration`, `Verification`, `OAuthCallbackError`
 * and the rest. The parameter is therefore **not** a value this application chose, and it is not a
 * value it can trust: anybody can type `/sign-in?error=anything` into the address bar. Everything
 * below treats it as an opaque untrusted token, matches it against a closed set, and returns a
 * reason that was written here. Nothing from the parameter is ever carried into the output.
 *
 * ## Why "out-of-domain" and "deactivated" share one reason
 *
 * The gate in `../../lib/auth/sign-in-decision.ts` distinguishes them — {@link SignInRefusal} is
 * `domain | deactivated` — but the Auth.js `signIn` callback returns a **boolean**, so both
 * refusals leave the server as the single code `AccessDenied`. There is no parameter value that
 * means "deactivated", and inventing one would be worse than not having it:
 *
 * A reason that said *deactivated* on its own would answer a question the platform refuses to
 * answer anywhere else (FR-190). Everything out of scope is `NOT_FOUND` precisely so that a
 * response cannot confirm a thing exists; a sign-in screen that separated "we do not know this
 * identity" from "we know it and switched it off" would hand that back at the front door. So the
 * refusal reason names **both** causes from {@link REFUSAL_CAUSES}, says in as many words that it
 * will not say which, and cannot be used to tell one from the other. `error-reason.test.ts` pins
 * that as an invariant over the whole vocabulary rather than as a property of one string.
 *
 * If the two ever do need separating, the change is in the auth layer and not here: a `signIn`
 * callback may return a redirect URL instead of `false`, which is the only way to get a narrower
 * code onto the query string — and it would still be a disclosure, so it would need its own
 * decision.
 */

/** The refusal kinds the sign-in gate can produce. Derived, so a new kind fails to compile here. */
type RefusalKind = SignInRefusal['kind']

/**
 * The two causes of a refusal, phrased as possibilities rather than as findings.
 *
 * Keyed by {@link RefusalKind} on purpose: adding a third refusal to `sign-in-decision.ts` is a
 * type error in this file until the cause is written, so the screen cannot silently fall behind
 * the gate.
 */
export const REFUSAL_CAUSES: Record<RefusalKind, string> = {
  domain: 'the Google account is not on a Workspace domain this deployment permits',
  deactivated: 'access through it has been withdrawn',
}

/**
 * A cause the sign-in screen can render. Both halves are required, for the reason
 * `components/ui/field-error.tsx` gives (FR-031): a code is searchable and quotable, an action is
 * what the person in front of the screen does next, and a message with neither is a dead end.
 */
export interface AuthErrorReason {
  /** The machine code. Stable, searchable, safe to put in a ticket. */
  readonly code: string
  /** One sentence naming the cause. Never names an address, an account or a person. */
  readonly summary: string
  /** What to do next. Not a restatement of what failed. */
  readonly action: string
}

/**
 * The closed vocabulary. Every reason the screen can ever show is one of these three objects —
 * there is no template, no interpolation and no branch that builds a string from input.
 */
export const AUTH_ERROR_REASONS = {
  /** `AccessDenied` — the `signIn` gate said no, for one of two reasons it will not distinguish. */
  refused: {
    code: 'E_AUTH_REFUSED',
    summary: `Sign-in was refused. Either ${REFUSAL_CAUSES.domain}, or ${REFUSAL_CAUSES.deactivated}. This screen does not say which.`,
    action:
      'Check you chose your work account rather than a personal one, then try again. If it was the right account, ask a Sisyphus administrator to confirm your access.',
  },
  /** `Configuration` — the deployment's own auth setup is wrong. Nothing the operator can fix. */
  configuration: {
    code: 'E_AUTH_CONFIGURATION',
    summary: 'Sign-in is not correctly set up on this deployment, so it could not be attempted.',
    action:
      'Retrying will not help. Report the code above to a Sisyphus administrator — the fix is in the panel’s own setup, not in anything you can change.',
  },
  /** Everything else: the provider round trip failed, or the parameter is one we do not know. */
  provider: {
    code: 'E_AUTH_PROVIDER',
    summary: 'Sign-in did not complete. The exchange with Google failed or was interrupted.',
    action:
      'Try again. If it keeps failing, report the code above to a Sisyphus administrator with the time you tried.',
  },
} as const satisfies Record<string, AuthErrorReason>

/**
 * Read the single value out of a query parameter that may be absent, repeated, or not a string at
 * all — a hand-written URL decides its own shape, and this must be total over all of them.
 */
const firstValue = (parameter: unknown): string => {
  if (typeof parameter === 'string') return parameter.trim()

  if (Array.isArray(parameter)) {
    const [first] = parameter as readonly unknown[]
    return typeof first === 'string' ? first.trim() : ''
  }

  return ''
}

/**
 * Translate the `error` query parameter into a reason, or `undefined` when there is nothing to
 * report — an ordinary unauthenticated visit, which is by far the common case and must not show an
 * error.
 *
 * A pure function of one untrusted string. It reads no session, performs no lookup and takes no
 * identity, so its answer cannot vary with whether an account exists — which is the property
 * FR-190 needs and the reason the signature is this narrow.
 */
export const authErrorReason = (parameter: unknown): AuthErrorReason | undefined => {
  switch (firstValue(parameter)) {
    case '':
      return undefined
    case 'AccessDenied':
      return AUTH_ERROR_REASONS.refused
    case 'Configuration':
      return AUTH_ERROR_REASONS.configuration
    default:
      // An unrecognised code is a failure we have no better words for, never a pass-through of the
      // caller's text. `Verification`, `OAuthCallbackError` and a typed-in nonsense value all land
      // in the same place, deliberately.
      return AUTH_ERROR_REASONS.provider
  }
}
