import { eq } from 'drizzle-orm'

import type { SisyphusDatabase } from '../../db'
import { scopedCredentials } from '../../db'
import type { AuthorisationDenial, MachineCredential } from '../context'

import {
  credentialSigningKey,
  SCOPED_CREDENTIAL_ALGORITHM,
  SCOPED_CREDENTIAL_AUDIENCE,
  SCOPED_CREDENTIAL_ISSUER,
  workflowIdFromSubject,
} from './credential-claims'

/**
 * Turning a presented token back into a {@link MachineCredential} — the verifying half of FR-037.
 *
 * ## One verifier, and why it is this one
 *
 * `machineProcedure` verifies nothing itself: it calls
 * `ctx.dependencies.resolveMachineCredential(headers)` and enforces the result. That dependency is
 * injected by whichever host mounts the machine surface, and there are two — the panel at
 * `/api/machine`, and the control plane, which sits beside the mint. Both used to carry their own
 * step-for-step copy of this algorithm, because neither can import the other.
 *
 * Two verifiers that can disagree about what a valid credential *is* is a defect waiting for a
 * divergent edit, so the shared half lives here, in the one package both already depend on, and
 * both hosts import it. What is left to a host is a single dependency binding: the JOSE
 * implementation it already has. See {@link ScopedCredentialJwtVerifier}.
 *
 * ## The claim policy is enforced here, not delegated to the host's library
 *
 * The verifier is handed the pinned algorithm, issuer and audience, and a correct implementation
 * checks all three. This module then **checks them again** against the claims the verifier
 * reports. That is not belt-and-braces for its own sake: it is what makes a host binding unable to
 * widen what the platform accepts. A host that passed its library the wrong options — or a library
 * that quietly treated `audience` as advisory — still cannot produce a credential from a token
 * addressed somewhere else, because the decision is not the library's to make.
 *
 * The one thing the host's library alone is trusted with is the signature, which is the one thing
 * that cannot be re-checked without this package taking a cryptography dependency of its own.
 *
 * ## Expiry comes from the row, never from the token
 *
 * `machineProcedure` enforces `credential.expiresAt`, and this returns the row's `expires_at` —
 * the column `machine.renewCredential` moves. The token's `exp` is a long hard ceiling and is
 * checked by the JOSE verifier; the row is the short window FR-037 asks for. Returning the token's
 * `exp` instead would make renewal a no-op fifteen minutes into every run, because renewal
 * deliberately puts nothing new on the wire.
 *
 * ## Why an unrecognised subject is refused rather than trusted
 *
 * `workflowIdFromSubject` returns `undefined` for anything that is not `workflow:<id>`, including
 * the `validation:<id>` subject a bundle validation run carries, and this module refuses it with
 * `subject_names_no_workflow`.
 *
 * That refusal survives T200 unchanged, and it is now load-bearing in a way it was not before.
 * `validation_credentials` and `machine.reportValidation` exist, so a validation credential is no
 * longer a token that authorises nothing — it is a token that authorises **one procedure against a
 * `validation_runs` row**. It must still never resolve to a {@link MachineCredential}, because every
 * `machineProcedure` reads `ctx.workflowId` and would be given the id of a run that does not exist.
 * The two subject spaces are resolved by two functions against two tables:
 * {@link inspectScopedCredential} here, and `inspectValidationCredential` in
 * `./validation-credential.ts`. Neither can answer for the other, and
 * {@link inspectCredentialToken} — the signature-and-claims half both share — deliberately returns
 * the raw `sub` rather than an id, so the choice of subject space is made by the caller and not by
 * whatever turned up on the wire.
 */

/** The header the executor presents its credential in. */
export const CREDENTIAL_HEADER = 'authorization'

/** The scheme, matched case-insensitively as RFC 7235 requires. */
export const CREDENTIAL_SCHEME = 'bearer'

/**
 * What this module asks a host's JOSE implementation to check.
 *
 * Mutable arrays and plain strings rather than `readonly` ones, because the point of this shape is
 * that `jose`'s own `jwtVerify` is assignable to {@link ScopedCredentialJwtVerifier} **without an
 * adapter**: a host passes the imported function straight through, so there is no host-written
 * verification code that could be written differently in two places.
 */
export interface ScopedCredentialJwtOptions {
  algorithms: string[]
  issuer: string
  audience: string
}

/** The claims a JOSE verifier reports back. A subset of `jose`'s `JWTVerifyResult`. */
export interface ScopedCredentialJwtResult {
  readonly payload: {
    readonly iss?: string
    readonly aud?: string | string[]
    readonly sub?: string
    readonly jti?: string
  }
  readonly protectedHeader: { readonly alg?: string }
}

/**
 * The host's JOSE binding.
 *
 * Signature-compatible with `jose`'s `jwtVerify`, deliberately: the host writes
 * `jwtVerify` and nothing else. It must reject a bad signature by throwing; every claim it also
 * checks is re-checked here, so a permissive one cannot widen the platform's acceptance.
 */
export type ScopedCredentialJwtVerifier = (
  token: string,
  key: Uint8Array,
  options: ScopedCredentialJwtOptions,
) => Promise<ScopedCredentialJwtResult>

/**
 * Why a presented credential was refused.
 *
 * Every one of these resolves to `null` and is refused identically — the distinction is for the
 * **audit trail**, which `AuthorisationDenial` otherwise collapses into a single
 * `machine_credential_missing` because `resolveMachineCredential` returns `MachineCredential |
 * null` and cannot say more. See {@link ScopedCredentialResolverOptions.recordDenial}.
 */
export type ScopedCredentialRefusal =
  | 'signature_or_claims_rejected'
  | 'algorithm_not_pinned'
  | 'issuer_mismatch'
  | 'audience_mismatch'
  | 'subject_names_no_workflow'
  | 'jti_absent'
  | 'credential_not_found'
  | 'credential_revoked'
  | 'credential_workflow_mismatch'

/**
 * The refusals that are decided before either subject space is consulted.
 *
 * Named as a subset so `./validation-credential.ts` can reuse {@link inspectCredentialToken}'s
 * verdict without restating it, and without inheriting `subject_names_no_workflow` — which would be
 * an untrue thing for the validation path to record.
 */
export type CredentialTokenRefusal = Extract<
  ScopedCredentialRefusal,
  'signature_or_claims_rejected' | 'algorithm_not_pinned' | 'issuer_mismatch' | 'audience_mismatch'
>

/** The outcome of inspecting one token: the credential, or the reason there is none. */
export interface ScopedCredentialOutcome {
  readonly credential: MachineCredential | null
  readonly refusal?: ScopedCredentialRefusal
}

/** See `guard.ts`: `noUncheckedIndexedAccess` is off, so indexing needs a type. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/**
 * The token out of an `Authorization: Bearer …` header, or `undefined`.
 *
 * @param headers - The request headers.
 */
export const bearerTokenFrom = (headers: Headers): string | undefined => {
  const header = headers.get(CREDENTIAL_HEADER)
  if (header === null) {
    return undefined
  }

  const separator = header.indexOf(' ')
  if (separator < 0) {
    return undefined
  }

  const scheme = header.slice(0, separator)
  const token = header.slice(separator + 1).trim()

  return scheme.toLowerCase() === CREDENTIAL_SCHEME && token !== '' ? token : undefined
}

export interface ScopedCredentialResolverOptions {
  readonly db: SisyphusDatabase
  /** `SISYPHUS_MACHINE_CREDENTIAL_SECRET`. Passed in; this package reads no environment. */
  readonly secret: string
  /** The host's JOSE binding — `jose`'s `jwtVerify`, passed straight through. */
  readonly jwtVerify: ScopedCredentialJwtVerifier
  /**
   * Optional, and the only reason a refusal here is more than a `null`.
   *
   * `machineProcedure` records every unresolved credential as `machine_credential_missing`,
   * because the dependency signature gives it nothing else to go on — a forged signature, a token
   * addressed to the interactive surface and an absent header look identical to it. Passing the
   * host's denial recorder here means the *precise* reason is recorded as
   * `machine_credential_invalid` before the coarse one is, so the trail can tell a torn-down
   * credential from an attempted forgery.
   *
   * Nothing is recorded when the request simply carried no credential: there is nothing to say
   * about it that `machine_credential_missing` does not already say.
   *
   * A failure here must not mask the refusal, so it is swallowed.
   */
  readonly recordDenial?: (denial: AuthorisationDenial) => Promise<void>
}

/** `aud` may be a string or an array; the platform's audience must be among it either way. */
const audienceIncludes = (audience: string | string[] | undefined): boolean =>
  typeof audience === 'string'
    ? audience === SCOPED_CREDENTIAL_AUDIENCE
    : (audience?.includes(SCOPED_CREDENTIAL_AUDIENCE) ?? false)

const refused = (refusal: ScopedCredentialRefusal): ScopedCredentialOutcome => ({
  credential: null,
  refusal,
})

/** What a token proved about itself, before anybody has decided what it is allowed to name. */
export interface CredentialTokenClaims {
  /** The `sub` claim verbatim. Deliberately not an id — see below. */
  readonly subject: string | undefined
  readonly jti: string | undefined
}

/**
 * The signature-and-claims half of verification, shared by both subject spaces (T200).
 *
 * Everything up to and including "this token was signed by the control plane, uses the pinned
 * algorithm, and is addressed to the machine surface" is identical for a workflow credential and a
 * validation credential, and it is the half where a mistake is a forgery rather than a mis-scoped
 * write. So it is written once. `./validation-credential.ts` calls this and then does its own
 * lookup; {@link inspectScopedCredential} below does the same.
 *
 * **It returns `sub` rather than an id, and that is the point of the split.** Handing back a
 * discriminated `{ kind, id }` would put the choice of subject space inside a `switch` at each call
 * site, and the failure mode of a missing case is a validation credential resolving to a workflow.
 * Returning the raw claim means each caller applies its own `…FromSubject`, and a caller that wants
 * workflows has no way to obtain a validation run id.
 *
 * @param options - The signing secret and the host's JOSE binding. The handle is unused here.
 * @param token - The compact JWT as presented.
 * @returns The claims, or the reason the token was refused before its subject was read.
 */
export const inspectCredentialToken = async (
  options: Pick<ScopedCredentialResolverOptions, 'jwtVerify' | 'secret'>,
  token: string,
): Promise<{ claims: CredentialTokenClaims } | { refusal: CredentialTokenRefusal }> => {
  let verified: ScopedCredentialJwtResult

  try {
    // The algorithm is pinned so a token presenting `alg: none` — or any asymmetric algorithm
    // against a key this process treats as symmetric — fails rather than being negotiated with.
    verified = await options.jwtVerify(token, credentialSigningKey(options.secret), {
      algorithms: [SCOPED_CREDENTIAL_ALGORITHM],
      issuer: SCOPED_CREDENTIAL_ISSUER,
      audience: SCOPED_CREDENTIAL_AUDIENCE,
    })
  } catch {
    return { refusal: 'signature_or_claims_rejected' }
  }

  // Re-checked rather than assumed. A host binding that dropped these options — or a library that
  // treated them as advisory — must not be able to widen what this platform accepts.
  if (verified.protectedHeader.alg !== SCOPED_CREDENTIAL_ALGORITHM) {
    return { refusal: 'algorithm_not_pinned' }
  }

  if (verified.payload.iss !== SCOPED_CREDENTIAL_ISSUER) {
    return { refusal: 'issuer_mismatch' }
  }

  if (!audienceIncludes(verified.payload.aud)) {
    return { refusal: 'audience_mismatch' }
  }

  return { claims: { subject: verified.payload.sub, jti: verified.payload.jti } }
}

/**
 * Verify one token and resolve it to the credential row behind it, keeping the reason.
 *
 * Pure with respect to the audit trail: it decides, and {@link verifyScopedCredential} is what
 * records. Exported so a test can assert *which* refusal a given token produces rather than only
 * that it produced one.
 *
 * @param options - The handle, the signing secret and the host's JOSE binding.
 * @param token - The compact JWT as presented.
 */
export const inspectScopedCredential = async (
  options: ScopedCredentialResolverOptions,
  token: string,
): Promise<ScopedCredentialOutcome> => {
  const inspected = await inspectCredentialToken(options, token)

  if ('refusal' in inspected) {
    return refused(inspected.refusal)
  }

  const workflowId = workflowIdFromSubject(inspected.claims.subject)
  if (workflowId === undefined) {
    return refused('subject_names_no_workflow')
  }

  const jti = inspected.claims.jti
  if (jti === undefined) {
    return refused('jti_absent')
  }

  const stored = firstRow(
    await options.db
      .select()
      .from(scopedCredentials)
      .where(eq(scopedCredentials.jti, jti))
      .limit(1),
  )

  // A `jti` with no row, or with a revoked one, is a *recognisable* replay: the token is intact and
  // inside its ceiling, and it is refused because the row it names has been superseded or torn
  // down. That is the property a fresh `jti` per issue buys.
  if (stored === undefined) {
    return refused('credential_not_found')
  }

  if (stored.revokedAt !== null) {
    return refused('credential_revoked')
  }

  if (stored.workflowId !== workflowId) {
    // The signed subject and the stored row disagree about whose credential this is. It should be
    // unreachable — both were written by the same transaction — so it is refused outright rather
    // than resolved in favour of either.
    return refused('credential_workflow_mismatch')
  }

  return {
    credential: {
      credentialId: stored.id,
      workflowId: stored.workflowId,
      jti: stored.jti,
      // The row, never the token. `machineProcedure` enforces this value and
      // `machine.renewCredential` is the only thing that may move it.
      expiresAt: stored.expiresAt,
    },
  }
}

/**
 * Verify one token and resolve it to the credential row behind it.
 *
 * @param options - The handle, the signing secret and the host's JOSE binding.
 * @param token - The compact JWT as presented.
 * @returns The credential, or `null` for anything that does not verify, does not name a workflow,
 *   names a credential that no longer exists, or names one that has been revoked.
 */
export const verifyScopedCredential = async (
  options: ScopedCredentialResolverOptions,
  token: string,
): Promise<MachineCredential | null> => {
  const outcome = await inspectScopedCredential(options, token)

  if (outcome.refusal !== undefined && options.recordDenial !== undefined) {
    try {
      await options.recordDenial({
        reason: 'machine_credential_invalid',
        detail: outcome.refusal,
      })
    } catch {
      // Recording is best-effort. Losing the trail must not turn a clean refusal into an error.
    }
  }

  return outcome.credential
}

/**
 * Build the `resolveMachineCredential` dependency the tRPC context asks for.
 *
 * @param options - The handle, the signing secret and the host's JOSE binding.
 */
export const createScopedCredentialResolver =
  (options: ScopedCredentialResolverOptions) =>
  async (headers: Headers): Promise<MachineCredential | null> => {
    const token = bearerTokenFrom(headers)
    return token === undefined ? null : verifyScopedCredential(options, token)
  }
