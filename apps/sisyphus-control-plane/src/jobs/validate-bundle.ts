import type {
  BootstrapPhaseOutcome,
  ValidationBootstrapPhase,
  ValidationOutcome,
} from '@bluetel-ai/sisyphus-api/client'
import { VALIDATION_BOOTSTRAP_PHASES } from '@bluetel-ai/sisyphus-api/client'
import type { ComputeLease, SisyphusDatabase, ValidationRun } from '@bluetel-ai/sisyphus-api/db'
import { setupBundleVersions, validationRuns } from '@bluetel-ai/sisyphus-api/db'
import { and, eq, isNotNull, isNull, lt } from 'drizzle-orm'

import type { ComputeProvisioner, ObjectStore } from '../aws'
import { mintValidationCredential } from '../credentials'

import { validationInstanceTag } from './instance-tag'
import type { ValidationJobEnvelope } from './job-envelope'
import { encodeUserData } from './job-envelope'
import type { JobOutcome } from './run-job'
import { runJob } from './run-job'

/**
 * Bundle validation runs (T047, FR-147, FR-148) — proving a setup bundle without starting an agent.
 *
 * A validation provisions an instance, runs bootstrap phases 2–5 against the archive, captures the
 * redacted output and tears down. No ticket, no workspace, no prompt, no agent. That is what turns
 * the otherwise blind upload-fail-fix-reupload loop into one command.
 *
 * ## Why it does not create a workflow row, and what that costs
 *
 * A validation has no owner-facing run, no prompt and no workspace. Recording it as a workflow
 * would mean loosening `workflows.owner_user_id`, `assembled_prompt` and `workspace_version_id` to
 * nullable **for every row in the table**, so that a handful of validations could sit in it — and
 * every real run would then be one `null` away from being unattributable. FR-147 chooses the other
 * way round: `validation_runs` is its own table, and the workflow columns stay `not null`.
 *
 * The cost of that choice was real, was stated here plainly while it stood, and is now paid (T200):
 *
 * - **`scoped_credentials.workflow_id` is `not null`**, so a validation run could not hold a
 *   credential row, its token was bounded by its own `exp` alone, and
 *   {@link import('../credentials').verifyScopedCredential} refused it outright. It still refuses
 *   it — a validation credential must never resolve to a workflow — but a validation run now has a
 *   row of its own in `validation_credentials`, minted by {@link mintValidationCredential} and
 *   accepted by `createValidationCredentialResolver`. The workflow columns are still `not null` and
 *   `scoped_credentials_live_key` is untouched.
 * - **The machine surface has no validation-run procedure.** It has one now:
 *   `machine.reportValidation`, built on `validationProcedure` rather than `machineProcedure`
 *   precisely because there is no `ctx.workflowId` for it to be scoped to. The executor reports its
 *   per-phase results there and the outcome is derived from them server-side.
 *
 * {@link completeBundleValidation} therefore has two callers' worth of work split between two
 * places, and the split is deliberate rather than residual: the **result** is recorded by the
 * machine surface, in the transaction that also retires the credential, because that is where the
 * authenticated instance is; the **instance** is destroyed here, by
 * {@link terminateFinishedValidationInstances}, because the machine surface holds no compute
 * provisioner and must not. `completeBundleValidation` remains the one-call path for a caller that
 * has the results in hand already — the admin surface driving a validation synchronously, and the
 * suites — and it stays idempotent against the machine surface having got there first.
 *
 * ## Why validation instances are tagged differently
 *
 * The FR-039 sweep judges an instance by whether a live lease records it, and a validation run
 * holds no lease — it cannot, since `compute_leases.workflow_id` is `not null` too. Tagged with a
 * bare id it would look exactly like the leak the sweep exists to destroy, and would be terminated
 * halfway through `setup.sh`. So it is tagged `validation:<runId>` and the reconciler leaves it
 * alone; see `instance-tag.ts`. That also means the reconciler is **not** the backstop here, which
 * is what {@link abandonStaleValidationRuns} is for.
 */

export const VALIDATE_BUNDLE_JOB_NAME = 'validate-bundle'

/**
 * How long a validation run may hold an instance before it is abandoned and the instance destroyed.
 *
 * Longer than a teardown budget and shorter than a working day: `setup.sh` may be installing a
 * toolchain, and the whole point of a validation is to find out that it hangs. Since the FR-039
 * sweep deliberately does not touch these instances, this is the **only** thing that ends one whose
 * executor never reports — so it is a bound on cost, not a convenience.
 */
export const VALIDATION_BUDGET_MS = 45 * 60 * 1000

/**
 * The bootstrap phases a validation run reaches.
 *
 * Deliberately not the whole `bootstrap_phase` enum: phases 6 and 7 are entry checkout and agent
 * start, and a validation stops before both by definition. A results object mentioning them would
 * be describing something that did not happen.
 *
 * The tuple itself moved to `@bluetel-ai/sisyphus-api`'s `src/enums/` in T200 and this is an alias
 * of it. It acquired two more consumers on the far side of the package boundary — the input schema
 * `machine.reportValidation` validates against, and the executor that fills that input in — and a
 * literal restated per consumer is how one of them comes to accept `agent_start`. The alias stays so
 * that this module and its callers keep reading in the vocabulary of the job.
 */
export const VALIDATION_PHASES = VALIDATION_BOOTSTRAP_PHASES

export type ValidationPhase = ValidationBootstrapPhase

export interface ValidationPhaseResult {
  readonly outcome: BootstrapPhaseOutcome
  readonly detail?: string
  readonly durationMs?: number
}

/** Per-phase results, keyed by phase, as `validation_runs.phase_results` records them. */
export type ValidationPhaseResults = Partial<Record<ValidationPhase, ValidationPhaseResult>>

export interface StartBundleValidationOptions {
  readonly db: SisyphusDatabase
  readonly compute: ComputeProvisioner
  readonly machineSurfaceUrl: string
  readonly credentialSecret: string
  readonly setupBundleVersionId: string
  /** The admin who asked for it. `validation_runs.triggered_by_user_id` is `not null` (FR-178). */
  readonly triggeredByUserId: string
  /**
   * Sizing and pricing. Stated by the caller rather than defaulted here for the same reason
   * `start-workflow.ts` reads them off the job spec: a validation that quietly ran on different
   * capacity from the runs it is meant to prove would prove less than it appears to.
   */
  readonly instanceType: string
  readonly purchaseMode: ComputeLease['purchaseMode']
  readonly now?: () => Date
}

/** The instance is up and the validation run is recorded against the bundle version. */
export interface ProvisionedValidation {
  readonly outcome: 'provisioned'
  readonly validationRunId: string
  readonly instanceId: string
}

/** The launch failed. Recorded as a failed validation naming the phase, not raised. */
export interface FailedValidationProvisioning {
  readonly outcome: 'provisioning_failed'
  readonly validationRunId: string
  readonly error: Error
}

export type StartBundleValidationOutcome = FailedValidationProvisioning | ProvisionedValidation

/** See `admit-workflow.ts`: `noUncheckedIndexedAccess` is off, so indexing needs an honest type. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/** Record a run's outcome and stop the clock. Written once; a validation has one ending. */
const finishRun = async (options: {
  readonly db: SisyphusDatabase
  readonly validationRunId: string
  readonly outcome: ValidationOutcome
  readonly phaseResults: ValidationPhaseResults
  readonly outputS3Key?: string
  readonly now: Date
}): Promise<ValidationRun | undefined> =>
  firstRow(
    await options.db
      .update(validationRuns)
      .set({
        outcome: options.outcome,
        phaseResults: options.phaseResults,
        outputS3Key: options.outputS3Key ?? null,
        endedAt: options.now,
      })
      // Only an unfinished run. FR-148 records one outcome per validation, and a retried report
      // must not rewrite the result somebody has already read.
      .where(and(eq(validationRuns.id, options.validationRunId), isNull(validationRuns.endedAt)))
      .returning(),
  )

/** The instance belonging to one validation run, if it is still up. */
const instanceFor = async (
  compute: ComputeProvisioner,
  validationRunId: string,
): Promise<string | undefined> => {
  const tag = validationInstanceTag(validationRunId)
  const instances = await compute.listWorkflowInstances()

  return instances.find((instance) => instance.workflowId === tag)?.instanceId
}

/**
 * Provision an instance to prove one bundle version.
 *
 * @param options - The seams, the bundle version, who asked, and the capacity to use.
 * @returns The run and its instance, or the recorded provisioning failure.
 * @throws If the bundle version does not exist — validating a bundle that is not registered is a
 *   caller error, not a validation result.
 */
export const startBundleValidation = async (
  options: StartBundleValidationOptions,
): Promise<StartBundleValidationOutcome> => {
  const { compute, db } = options
  const now = (options.now ?? ((): Date => new Date()))()

  const version = firstRow(
    await db
      .select({
        s3Key: setupBundleVersions.s3Key,
        contentDigest: setupBundleVersions.contentDigest,
        version: setupBundleVersions.version,
      })
      .from(setupBundleVersions)
      .where(eq(setupBundleVersions.id, options.setupBundleVersionId))
      .limit(1),
  )

  if (version === undefined) {
    throw new Error(
      `Setup bundle version ${options.setupBundleVersionId} is not registered, so there is no archive to validate.`,
    )
  }

  const run = firstRow(
    await db
      .insert(validationRuns)
      .values({
        setupBundleVersionId: options.setupBundleVersionId,
        triggeredByUserId: options.triggeredByUserId,
        startedAt: now,
      })
      .returning({ id: validationRuns.id }),
  )

  if (run === undefined) {
    throw new Error('No validation run row was written, so a launch would be unattributable.')
  }

  // The row exists before the launch, so an instance can always be tagged with an id that is
  // already recorded — the reverse order would leave a running instance tagged with nothing.
  const credential = await mintValidationCredential({
    db,
    validationRunId: run.id,
    secret: options.credentialSecret,
    now,
  })

  const envelope: ValidationJobEnvelope = {
    machineSurfaceUrl: options.machineSurfaceUrl,
    scopedCredential: credential.token,
    setupBundle: {
      s3Key: version.s3Key,
      contentDigest: version.contentDigest,
      version: version.version,
    },
    mode: 'validation',
  }

  try {
    const launched = await compute.launch({
      workflowId: validationInstanceTag(run.id),
      instanceType: options.instanceType,
      purchaseMode: options.purchaseMode,
      userData: encodeUserData(envelope, `validation run ${run.id}`),
    })

    return { outcome: 'provisioned', validationRunId: run.id, instanceId: launched.instanceId }
  } catch (thrown) {
    const error = thrown instanceof Error ? thrown : new Error(String(thrown))

    // A capacity refusal is a validation result, not an exception the caller has to interpret: the
    // run is recorded as failed at the phase that failed, which is what FR-148 asks the panel to
    // be able to show.
    await finishRun({
      db,
      validationRunId: run.id,
      outcome: 'failed',
      phaseResults: { provisioning: { outcome: 'failed', detail: error.message } },
      now,
    })

    return { outcome: 'provisioning_failed', validationRunId: run.id, error }
  }
}

export interface CompleteBundleValidationOptions {
  readonly db: SisyphusDatabase
  readonly compute: ComputeProvisioner
  readonly validationRunId: string
  readonly phaseResults: ValidationPhaseResults
  /** Where the captured, redacted `setup.sh` output was written (FR-089, FR-148). */
  readonly outputS3Key?: string
  /** Supplied to confirm the captured output is durable before the instance is destroyed. */
  readonly objectStore?: ObjectStore
  readonly outputBucket?: string
  readonly now?: () => Date
}

export interface CompletedValidation {
  readonly outcome: ValidationOutcome
  readonly validationRunId: string
  readonly terminatedInstanceId: string | undefined
  /** True when the run had already ended and this call changed nothing. */
  readonly alreadyRecorded: boolean
  /** The captured output was named but is not in durable storage. */
  readonly outputUnconfirmed: boolean
}

/**
 * Record a validation's results and tear its instance down.
 *
 * Same order as FR-038's teardown, for the same reason: the captured `setup.sh` output is the
 * entire product of a validation run, and destroying the instance before confirming it is durable
 * would lose the only thing anybody wanted. Unlike a workflow teardown there is no budget to
 * exhaust here — the results are being written in this call, so if the output is missing it is
 * missing now and will not appear later. The instance is destroyed regardless and the gap is
 * reported, because holding it would cost money to no purpose.
 *
 * @param options - The seams, the run, its per-phase results and where its output went.
 */
export const completeBundleValidation = async (
  options: CompleteBundleValidationOptions,
): Promise<CompletedValidation> => {
  const { compute, db, validationRunId } = options
  const now = (options.now ?? ((): Date => new Date()))()

  // A phase that was not reported at all is not a failure — a run that stopped at `bundle_verify`
  // never had a `setup_script` phase to report. Only a phase that ran and did not succeed fails
  // the validation.
  const failedPhase = VALIDATION_PHASES.find((phase) => {
    const result: ValidationPhaseResult | undefined = options.phaseResults[phase]
    return result !== undefined && result.outcome !== 'succeeded'
  })
  const outcome = failedPhase === undefined ? 'passed' : 'failed'

  let outputUnconfirmed = false
  if (
    options.outputS3Key !== undefined &&
    options.objectStore !== undefined &&
    options.outputBucket !== undefined
  ) {
    outputUnconfirmed =
      (await options.objectStore.head({
        bucket: options.outputBucket,
        key: options.outputS3Key,
      })) === undefined
  }

  const recorded = await finishRun({
    db,
    validationRunId,
    outcome,
    phaseResults: options.phaseResults,
    ...(options.outputS3Key === undefined ? {} : { outputS3Key: options.outputS3Key }),
    now,
  })

  const instanceId = await instanceFor(compute, validationRunId)
  if (instanceId !== undefined) {
    await compute.terminate({ instanceId })
  }

  return {
    outcome,
    validationRunId,
    terminatedInstanceId: instanceId,
    alreadyRecorded: recorded === undefined,
    outputUnconfirmed,
  }
}

export interface AbandonedValidation {
  readonly validationRunId: string
  readonly terminatedInstanceId: string | undefined
}

/**
 * End validation runs that have outlived their budget, destroying their instances.
 *
 * The FR-039 reconciler deliberately leaves validation instances alone — it cannot tell a healthy
 * one from a leak, because neither holds a lease — so this is the **only** thing that stops one
 * running for ever when its executor dies mid-`setup.sh`. Which is precisely the failure a
 * validation run exists to discover, so it is not a rare path.
 *
 * @param options - The seams and the budget in force.
 */
export const abandonStaleValidationRuns = async (options: {
  readonly db: SisyphusDatabase
  readonly compute: ComputeProvisioner
  readonly budgetMs?: number
  readonly now?: () => Date
}): Promise<readonly AbandonedValidation[]> => {
  const now = (options.now ?? ((): Date => new Date()))()
  const budgetMs = options.budgetMs ?? VALIDATION_BUDGET_MS
  const cutoff = new Date(now.getTime() - budgetMs)

  const stale = await options.db
    .select({ id: validationRuns.id })
    .from(validationRuns)
    .where(and(isNull(validationRuns.endedAt), lt(validationRuns.startedAt, cutoff)))

  const abandoned: AbandonedValidation[] = []

  for (const run of stale) {
    await finishRun({
      db: options.db,
      validationRunId: run.id,
      outcome: 'failed',
      phaseResults: {
        setup_script: {
          outcome: 'timed_out',
          detail: `the run reported nothing within ${String(Math.round(budgetMs / 1000))}s and was abandoned`,
        },
      },
      now,
    })

    const instanceId = await instanceFor(options.compute, run.id)
    if (instanceId !== undefined) {
      await options.compute.terminate({ instanceId })
    }

    abandoned.push({ validationRunId: run.id, terminatedInstanceId: instanceId })
  }

  return abandoned
}

/**
 * **Destroy the instances of validation runs that have already reported (T200, FR-147).**
 *
 * Before `machine.reportValidation` existed, a validation run only ever ended by way of
 * {@link completeBundleValidation} or {@link abandonStaleValidationRuns} — and both of those destroy
 * the instance in the same call that ends the run, so nothing was left holding compute. That is no
 * longer true, and this closes the gap it opened rather than leaving it: an instance now ends its
 * own run by reporting, from a surface that holds no compute provisioner and must not be given one
 * (FR-005). So the row is finished and the machine is still up.
 *
 * {@link abandonStaleValidationRuns} is **not** the backstop for that, and cannot be made one
 * without lying: it selects on `ended_at is null`, which a reported run no longer satisfies, and
 * widening it would have it write a `timed_out` phase over a result somebody has already read. This
 * selects the complement — runs that *have* ended — and writes nothing at all. It only terminates.
 *
 * A reported run whose instance has already gone is the ordinary case, not an error: a validation
 * that reports and then exits leaves a machine that its own launch unit may shut down before this
 * sweep next runs. So an absent instance is silence, and only a termination is reported back.
 *
 * @param options - The seams. No budget: a run that has ended has no time left to be given.
 * @returns One entry per instance actually destroyed.
 */
export const terminateFinishedValidationInstances = async (options: {
  readonly db: SisyphusDatabase
  readonly compute: ComputeProvisioner
}): Promise<readonly AbandonedValidation[]> => {
  const finished = await options.db
    .select({ id: validationRuns.id })
    .from(validationRuns)
    .where(isNotNull(validationRuns.endedAt))

  const terminated: AbandonedValidation[] = []

  for (const run of finished) {
    const instanceId = await instanceFor(options.compute, run.id)
    if (instanceId !== undefined) {
      await options.compute.terminate({ instanceId })
      terminated.push({ validationRunId: run.id, terminatedInstanceId: instanceId })
    }
  }

  return terminated
}

/** Starting a validation, wrapped in the uniform job envelope. */
export const runValidateBundle = (
  options: StartBundleValidationOptions,
): Promise<JobOutcome<StartBundleValidationOutcome>> =>
  runJob(VALIDATE_BUNDLE_JOB_NAME, () => startBundleValidation(options))
