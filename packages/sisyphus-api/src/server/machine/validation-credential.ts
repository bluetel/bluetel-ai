import { eq } from 'drizzle-orm'

import { validationCredentials } from '../../db'
import type { AuthorisationDenial, ValidationRunCredential } from '../context'

import { validationRunIdFromSubject } from './credential-claims'
import type { ScopedCredentialResolverOptions } from './credential-verification'
import { bearerTokenFrom, inspectCredentialToken } from './credential-verification'

/**
 * **Turning a `validation:<id>` token into a credential (T200, FR-147, 003/FR-052).**
 *
 * ## What was here before, and why it was a refusal rather than a gap
 *
 * `credential-verification.ts` refused this subject form outright, and said so on purpose: a
 * validation run had no `scoped_credentials` row it could name, because that table's `workflow_id`
 * is `not null`, and the machine surface had no procedure that was not scoped to a workflow. So the
 * control plane minted a token whose only honest treatment was to be rejected, and
 * `apps/sisyphus-executor` halted on `validationModeUnsupportedError` before touching the network.
 * The refusal was the correct behaviour for a platform in that state — a credential that resolved
 * to *some* workflow would have been strictly worse — and this module is what makes it no longer
 * the state.
 *
 * ## The mirror, and the two things it deliberately does not share
 *
 * Everything up to "this token was signed by the control plane, uses the pinned algorithm and is
 * addressed to the machine surface" is {@link inspectCredentialToken}'s, shared verbatim with the
 * workflow path — a second copy of the claim policy is how two verifiers come to disagree about
 * what a valid credential is.
 *
 * What is **not** shared is the subject space and the table. `validationRunIdFromSubject` yields
 * nothing for a `workflow:<id>` subject and `workflowIdFromSubject` yields nothing for this one, and
 * each resolver reaches exactly one table. That is why a stolen workflow credential cannot report a
 * validation result and a validation credential cannot report anything about a run: not because a
 * check would catch it, but because neither resolver has a function that would hand it the other
 * kind of id. See the note on `validationRunIdFromSubject` for why this is two functions rather than
 * one returning a discriminated union.
 *
 * ## Expiry comes from the row, exactly as it does for a workflow
 *
 * The token's `exp` is the twelve-hour ceiling every credential this platform mints carries; the
 * row's `expires_at` is the short window. `validationProcedure` enforces the row. A validation is
 * bounded at 45 minutes by `VALIDATION_BUDGET_MS` and its window is 15, so a long `setup.sh` will
 * legitimately outlive its first window — which is why the row's value, and not the token's, is
 * what is returned.
 *
 * ## Nothing here touches the agent credential pool (003/FR-052)
 *
 * A credential produced by this module names a `validation_runs` row and nothing else. There is no
 * lease to acquire, no seat to hold and no column on `validation_credentials` through which either
 * could be recorded — so "proving a bundle does not consume pool capacity" is a property of the
 * shape rather than a rule the allocator has to honour.
 */

/**
 * Why a presented validation credential was refused.
 *
 * The first four are {@link inspectCredentialToken}'s and mean exactly what they mean on the
 * workflow path. The rest are this module's, and `subject_names_no_validation_run` is deliberately
 * *not* spelled `subject_names_no_workflow`: recording a workflow-shaped refusal for a validation
 * request would make the trail say something untrue about which surface was being reached for.
 */
export type ValidationCredentialRefusal =
  | 'signature_or_claims_rejected'
  | 'algorithm_not_pinned'
  | 'issuer_mismatch'
  | 'audience_mismatch'
  | 'subject_names_no_validation_run'
  | 'jti_absent'
  | 'credential_not_found'
  | 'credential_revoked'
  | 'credential_validation_run_mismatch'

/** The outcome of inspecting one token: the credential, or the reason there is none. */
export interface ValidationCredentialOutcome {
  readonly credential: ValidationRunCredential | null
  readonly refusal?: ValidationCredentialRefusal
}

/** See `guard.ts`: `noUncheckedIndexedAccess` is off, so indexing needs a type. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

const refused = (refusal: ValidationCredentialRefusal): ValidationCredentialOutcome => ({
  credential: null,
  refusal,
})

/**
 * Verify one token and resolve it to the `validation_credentials` row behind it, keeping the reason.
 *
 * Pure with respect to the audit trail: it decides, and {@link verifyValidationCredential} records.
 * Exported so a test can assert *which* refusal a given token produces rather than only that it
 * produced one.
 *
 * @param options - The handle, the signing secret and the host's JOSE binding.
 * @param token - The compact JWT as presented.
 */
export const inspectValidationCredential = async (
  options: ScopedCredentialResolverOptions,
  token: string,
): Promise<ValidationCredentialOutcome> => {
  const inspected = await inspectCredentialToken(options, token)

  if ('refusal' in inspected) {
    return refused(inspected.refusal)
  }

  const validationRunId = validationRunIdFromSubject(inspected.claims.subject)
  if (validationRunId === undefined) {
    return refused('subject_names_no_validation_run')
  }

  const jti = inspected.claims.jti
  if (jti === undefined) {
    return refused('jti_absent')
  }

  const stored = firstRow(
    await options.db
      .select()
      .from(validationCredentials)
      .where(eq(validationCredentials.jti, jti))
      .limit(1),
  )

  // A `jti` with no row, or with a revoked one, is a *recognisable* replay: the token is intact and
  // inside its ceiling, and it is refused because the row it names has been superseded or torn
  // down. That is the property `validation_credentials_jti_key` plus a fresh `jti` per mint buys.
  if (stored === undefined) {
    return refused('credential_not_found')
  }

  if (stored.revokedAt !== null) {
    return refused('credential_revoked')
  }

  if (stored.validationRunId !== validationRunId) {
    // The signed subject and the stored row disagree about whose credential this is. It should be
    // unreachable — both were written by the same transaction — so it is refused outright rather
    // than resolved in favour of either.
    return refused('credential_validation_run_mismatch')
  }

  return {
    credential: {
      credentialId: stored.id,
      validationRunId: stored.validationRunId,
      jti: stored.jti,
      // The row, never the token. See the module note.
      expiresAt: stored.expiresAt,
    },
  }
}

/**
 * Verify one token and resolve it to the credential row behind it.
 *
 * @param options - The handle, the signing secret and the host's JOSE binding.
 * @param token - The compact JWT as presented.
 * @returns The credential, or `null` for anything that does not verify, does not name a validation
 *   run, names a credential that no longer exists, or names one that has been revoked.
 */
export const verifyValidationCredential = async (
  options: ScopedCredentialResolverOptions,
  token: string,
): Promise<ValidationRunCredential | null> => {
  const outcome = await inspectValidationCredential(options, token)

  if (outcome.refusal !== undefined && options.recordDenial !== undefined) {
    try {
      await options.recordDenial({
        reason: 'machine_credential_invalid',
        detail: outcome.refusal,
      } satisfies AuthorisationDenial)
    } catch {
      // Recording is best-effort. Losing the trail must not turn a clean refusal into an error.
    }
  }

  return outcome.credential
}

/**
 * Build the `resolveValidationCredential` dependency the tRPC context asks for.
 *
 * The same header and the same scheme as the workflow resolver: an instance presents one
 * `Authorization: Bearer …` and the **subject** decides which of the two resolvers can do anything
 * with it. A host wires both; neither can produce the other's credential.
 *
 * @param options - The handle, the signing secret and the host's JOSE binding.
 */
export const createValidationCredentialResolver =
  (options: ScopedCredentialResolverOptions) =>
  async (headers: Headers): Promise<ValidationRunCredential | null> => {
    const token = bearerTokenFrom(headers)
    return token === undefined ? null : verifyValidationCredential(options, token)
  }
