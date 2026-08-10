import { TRPCError } from '@trpc/server'
import { and, eq, isNull } from 'drizzle-orm'

import type { SisyphusDatabase, ValidationRun } from '../../db'
import { validationCredentials, validationRuns } from '../../db'
import type { ValidationBootstrapPhase, ValidationOutcome } from '../../enums'
import type { ReportValidationInput, ValidationPhaseResultInput } from '../../schemas'
import { reportValidationInput } from '../../schemas'
import type { ValidationRunCredential } from '../context'
import { validationProcedure } from '../procedures'

import { firstRow } from './guard'

/**
 * **`machine.reportValidation` — where a bundle validation's results land (T200, FR-147, FR-148).**
 *
 * ## What was missing, stated as it was
 *
 * `jobs/validate-bundle.ts` has provisioned validation instances since T047 and `validation_runs`
 * has been able to record their results since the first migration. What did not exist was any way
 * for the instance to say what happened: every procedure on this surface was scoped to
 * `ctx.workflowId`, a validation has no workflow, and `completeBundleValidation` was written "to be
 * called by whatever eventually can — it takes the results rather than collecting them". Nothing
 * ever called it with real results, so a validation run provisioned, bootstrapped, tore down and
 * recorded nothing. This is the missing end, and `validationProcedure` is what makes it reachable.
 *
 * ## The outcome is derived here, never taken from the wire
 *
 * `reportValidationInput` carries no `outcome` field. `passed` and `failed` are computed from the
 * phases the instance reported — any phase that ran and did not succeed fails the validation — for
 * the same reason the input carries no run id: a wire field would be a second copy of a fact already
 * on the wire, free to contradict it, and the copy an operator reads.
 *
 * The derivation matches {@link import('../../../../../apps/sisyphus-control-plane/src/jobs/validate-bundle').completeBundleValidation}
 * deliberately, including the part that looks like leniency: **a phase that was not reported at all
 * is not a failure.** A run that stopped at `bundle_verify` never had a `setup_script` phase to
 * report, and treating the absence as a failure would report two failures for one fault. What is
 * *not* lenient is the empty report — `reportValidationInput` requires at least one phase, so there
 * is no payload that derives `passed` from having said nothing.
 *
 * ## First report wins, and a retry is answered rather than refused
 *
 * The executor buffers and retries when this surface is unreachable and cannot tell a lost response
 * from a failed write (FR-047). So the update is conditional on `ended_at is null` — FR-148 records
 * one outcome per validation, and a retried report must not rewrite a result somebody has already
 * read — and a report that changes nothing answers `alreadyRecorded: true` rather than throwing.
 * An error here would push a working instance into failing on the report of its own success.
 *
 * ## The credential is revoked in the same transaction as the result
 *
 * A validation has exactly one thing to say and this is it, so the credential that authorised it has
 * no further use. Revoking it in the same transaction that ends the run means the window between
 * "the result is recorded" and "the token is inert" does not exist: an instance that is torn down
 * slowly, or whose user-data is read off a stopped volume afterwards, is holding a credential that
 * `inspectValidationCredential` already refuses as `credential_revoked` — which is a *recognisable*
 * refusal rather than a mystery, because the row is still there saying so.
 *
 * This is stricter than the workflow path, and deliberately: `machine.renewCredential` exists
 * because a run reports many times over hours. A validation reports once.
 */

/** Per-phase results, keyed by phase, exactly as `validation_runs.phase_results` stores them. */
export type ValidationPhaseResults = Partial<
  Record<ValidationBootstrapPhase, Omit<ValidationPhaseResultInput, 'phase'>>
>

/** What `reportValidation` answers with. */
export interface ValidationReport {
  readonly validationRunId: string
  /** Derived from the phases, never read off the wire. */
  readonly outcome: ValidationOutcome
  /** The run row as it now stands, or `null` when this call changed nothing. */
  readonly run: ValidationRun | null
  /** True when the run had already ended and this report was a retry of one already recorded. */
  readonly alreadyRecorded: boolean
}

/** The context a `validationProcedure` resolver runs with. The sibling of `MachineContext`. */
export interface ValidationContext {
  readonly db: SisyphusDatabase
  readonly validationRunId: string
  readonly credential: ValidationRunCredential
}

/**
 * The wire's ordered array, as the `phase_results` document.
 *
 * The array is what the executor sends because order is what a reader needs; the keyed object is
 * what the column has always held and what `completeBundleValidation` reads. The schema has already
 * established that no phase appears twice, so this cannot silently drop a result.
 *
 * @param phaseResults - The validated, distinct per-phase results.
 */
export const validationPhaseResults = (
  phaseResults: readonly ValidationPhaseResultInput[],
): ValidationPhaseResults =>
  phaseResults.reduce<ValidationPhaseResults>((document, { phase, ...result }) => {
    document[phase] = result
    return document
  }, {})

/**
 * The verdict a set of phase results implies (FR-148).
 *
 * Exported so the derivation can be asserted directly rather than only through a database round
 * trip — it is the one piece of judgement in this module, and the panel renders its answer.
 *
 * @param phaseResults - The phases the instance reported.
 * @returns `failed` when any reported phase did not succeed, `passed` otherwise.
 */
export const validationOutcomeFor = (
  phaseResults: readonly ValidationPhaseResultInput[],
): ValidationOutcome =>
  phaseResults.some((result) => result.outcome !== 'succeeded') ? 'failed' : 'passed'

/**
 * Record one validation's results against the credential's run, and retire the credential.
 *
 * @param ctx - The validation resolver context.
 * @param input - The validated `reportValidation` payload.
 * @returns The derived outcome and the row, or the outcome and `alreadyRecorded` for a retry.
 * @throws {TRPCError} `NOT_FOUND` when the run no longer exists — which should be unreachable, since
 *   the credential's foreign key is that row, and is refused rather than silently ignored.
 */
export const reportValidation = async (
  ctx: ValidationContext,
  input: ReportValidationInput,
): Promise<ValidationReport> => {
  const outcome = validationOutcomeFor(input.phaseResults)
  const now = new Date()

  return ctx.db.transaction(async (tx) => {
    const run = firstRow(
      await tx
        .select({ id: validationRuns.id })
        .from(validationRuns)
        .where(eq(validationRuns.id, ctx.validationRunId))
        .limit(1),
    )

    if (run === undefined) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'This validation run no longer exists.' })
    }

    const recorded = firstRow(
      await tx
        .update(validationRuns)
        .set({
          outcome,
          phaseResults: validationPhaseResults(input.phaseResults),
          outputS3Key: input.outputS3Key ?? null,
          endedAt: now,
        })
        // Only an unfinished run: one outcome per validation (FR-148), and a retried report must
        // not rewrite a result somebody has already read.
        .where(and(eq(validationRuns.id, ctx.validationRunId), isNull(validationRuns.endedAt)))
        .returning(),
    )

    // Retired whether or not this call was the one that wrote the result. A retry that lost the
    // race still means the instance has finished speaking, and a credential left live after that
    // is a token with nothing left to authorise.
    await tx
      .update(validationCredentials)
      .set({ revokedAt: now })
      .where(
        and(
          eq(validationCredentials.id, ctx.credential.credentialId),
          isNull(validationCredentials.revokedAt),
        ),
      )

    return {
      validationRunId: ctx.validationRunId,
      outcome,
      run: recorded ?? null,
      alreadyRecorded: recorded === undefined,
    }
  })
}

/**
 * `machine.reportValidation` — ready to mount beside the other machine procedures.
 *
 * The one procedure on this surface built on `validationProcedure` rather than `machineProcedure`,
 * which is what makes "a workflow credential cannot report a validation result, and a validation
 * credential cannot report anything else" a property of the mount rather than of a check inside it.
 */
export const reportValidationProcedure = validationProcedure.input(reportValidationInput).mutation(
  async ({ ctx, input }): Promise<ValidationReport> =>
    reportValidation(
      {
        db: ctx.db,
        validationRunId: ctx.validationRunId,
        credential: ctx.validationCredential,
      },
      input,
    ),
)
