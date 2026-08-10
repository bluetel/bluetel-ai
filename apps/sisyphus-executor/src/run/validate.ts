/**
 * **Running a bundle validation to completion (T200, FR-147, FR-148).**
 *
 * ## What this replaces
 *
 * `validationModeUnsupportedError`. Until T200 this file did not exist and `main.ts` threw at the
 * boundary: the envelope's `mode` was parsed, a validation envelope was recognised, and the process
 * exited having attempted nothing. The error said exactly why — a validation reports against the
 * bundle version rather than a workflow row, and the machine surface exposed no procedure for that
 * — and it was the honest behaviour while that was true. `machine.reportValidation` and
 * `validation_credentials` make it no longer true, so the refusal is gone rather than narrowed, and
 * this is what a validation envelope reaches instead.
 *
 * ## The shape, and why it is so much smaller than `./execute.ts`
 *
 * A validation is bootstrap phases 2–5 and a sentence about how they went. There is no workspace to
 * check out, no agent to start, no conversation to snapshot, no caps to enforce, no supervision to
 * poll and no terminal state to transition. So this module composes three things — the workspace
 * root, `runBundleBootstrap`, and one report — and deliberately reuses `runBundleBootstrap` rather
 * than reimplementing the phases. That reuse is the *point* of a validation: it proves the bundle
 * against the same code a real run boots with, so a bundle that validates and then fails at
 * `bundle_verify` on a workflow would be a defect in this platform rather than in the bundle.
 *
 * ## A failed phase is a result, not an exception
 *
 * `runBundleBootstrap` throws {@link BootstrapPhaseError} naming the phase, which is right for a
 * workflow: the run has failed and the error carries the phase to the terminal report. Here the
 * failure **is** the product. A bundle whose `setup.sh` exits non-zero is precisely what a
 * validation exists to discover, so the throw is caught, the phase has already been recorded with
 * its outcome and its sanitised detail, and the report is sent exactly as a passing one is. The only
 * thing that reaches the caller as a rejection is a failure to *report*, which is the one condition
 * nobody upstream can see.
 *
 * ## Nothing here names the validation run, and that is deliberate
 *
 * `validationJobEnvelopeSchema` carries no id: "the run identifies itself by its credential's
 * subject. Adding an id here would be a second place for the same fact to be recorded and a second
 * place for it to be wrong." That still holds, and this module honours it rather than working around
 * it — there is no token parsing on the instance and no second copy of the subject vocabulary. The
 * server takes the run from the verified credential; the object key is derived from the archive's
 * own digest and a fresh identifier, and becomes findable by being **reported**, since
 * `validation_runs.output_s3_key` is whatever the instance says it wrote.
 *
 * ## Every byte of `setup.sh` output is sanitised before it leaves the instance
 *
 * The captured output is the whole value of a failed validation and it is a client's build log, so
 * the redaction pipeline is not optional here. `runBundleBootstrap` produces `SanitisedText`, the
 * report type requires it, and the upload below writes that same value — there is no path in this
 * module by which raw output reaches the wire or the bucket (FR-045, FR-089).
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { isValidationBootstrapPhase } from '@bluetel-ai/sisyphus-api/client'

import type {
  BootstrapPhaseFinished,
  BootstrapPhaseReporter,
  BundleArchiveStore,
} from '../bootstrap'
import {
  agentConfigDir,
  BootstrapPhaseError,
  prepareWorkspaceRoot,
  runBundleBootstrap,
} from '../bootstrap'
import type { ValidationJobEnvelope } from '../job-envelope'
import type { SanitisedText } from '../output'
import { EMPTY_SANITISED_TEXT, sanitise } from '../output'
import type {
  ValidationPhaseReport,
  ValidationReportResult,
  ValidationSurfaceClient,
} from '../report'
import { createHttpValidationTransport, createValidationSurfaceClient } from '../report'
import type { S3Operations } from '../storage'
import { createS3BundleArchiveStore, createS3Operations } from '../storage'

import { DEFAULT_BUNDLE_SUBDIRECTORY, setupBundleReference } from './bootstrap'

/**
 * The instance-level environment a validation needs.
 *
 * A strict subset of `ExecutorEnvironment`, written as its own type rather than reused: a validation
 * has no forge, no snapshots bucket and no workspace entries, and a type that admitted them would
 * invite a later edit to use one.
 */
export interface ValidationEnvironment {
  readonly region: string
  /** The instance-level fallback. The envelope's `machineSurfaceUrl` takes precedence. */
  readonly machineSurfaceUrl: string
  readonly bundlesBucket: string
  /** Where the captured `setup.sh` output is written (FR-148). The run's only artifact. */
  readonly logsBucket: string
  readonly workspaceRoot: string
}

/**
 * Where one validation's captured output goes.
 *
 * Grouped by the archive's content digest, because that is the thing an operator has in hand and the
 * thing every proof of one bundle version has in common. Suffixed with a fresh identifier rather
 * than overwriting, because two validations of one archive are two separate proofs — the second is
 * usually the one taken after a fix, and destroying the first would destroy the evidence of what was
 * wrong.
 *
 * @param contentDigest - The archive's registered sha256, from the envelope.
 * @param token - A per-run identifier. Supplied so the key is a pure function and testable.
 */
export const validationOutputKey = (contentDigest: string, token: string): string =>
  `validations/${contentDigest}/${token}.txt`

export interface RunValidationOptions {
  readonly envelope: ValidationJobEnvelope
  readonly environment: ValidationEnvironment
  readonly client: ValidationSurfaceClient
  readonly archives: BundleArchiveStore
  /** Injected in tests, so no validation opens a socket. */
  readonly operations: S3Operations
  /** Where the archive is unpacked. Defaults to a sibling of the workspace root. */
  readonly bundleDir?: string
  /** Injected in tests so durations are measured rather than slept through. */
  readonly now?: () => number
  /** Injected in tests so the output key is deterministic. */
  readonly token?: string
  /** Where a failure to persist the captured output is noted. It never fails the report. */
  readonly onOutputFailure?: (error: unknown) => void
}

export interface ValidationRunOutcome {
  /** What the surface recorded, including the outcome it derived from the phases. */
  readonly report: ValidationReportResult
  /** The phases as they were reported, in the order they ran. */
  readonly phaseResults: readonly ValidationPhaseReport[]
  /** Set when the captured output was written; absent when there was none, or it could not be. */
  readonly outputS3Key?: string
}

/**
 * One phase result, or `undefined` for a phase a validation cannot report.
 *
 * `runBundleBootstrap` only runs phases 2–5, so in practice everything it reports is in range. The
 * guard is here anyway, and it is the shared one from `@bluetel-ai/sisyphus-api/client` rather than
 * a local list: the input schema on the far side validates against the same tuple, and a report
 * refused wholesale for one stray phase would lose four good ones — which is the wrong way to
 * discover that the two ends had come apart.
 */
export const validationPhaseReport = (
  event: BootstrapPhaseFinished,
): ValidationPhaseReport | undefined => {
  if (!isValidationBootstrapPhase(event.phase)) {
    return undefined
  }

  return {
    phase: event.phase,
    outcome: event.outcome,
    durationMs: event.durationMs,
    ...(event.detail === undefined ? {} : { detail: sanitise(event.detail) }),
  }
}

/**
 * Collect finished phases, in order.
 *
 * `phaseStarted` is deliberately a no-op. A workflow reports each phase as it begins because a user
 * is watching (FR-145); a validation has no workflow row for a live view to render, so a start
 * report would have nowhere to go, and inventing somewhere for it would be a schema change in
 * service of a screen nobody opens. Durations still come out right — `runPhase` measures them and
 * hands them to `phaseFinished`.
 */
const collectingReporter = (into: ValidationPhaseReport[]): BootstrapPhaseReporter => ({
  phaseStarted: () => undefined,
  phaseFinished: (event) => {
    const result = validationPhaseReport(event)
    if (result !== undefined) {
      into.push(result)
    }
  },
})

/**
 * Write the captured output, and never let that failure become the run's.
 *
 * A validation whose output could not be stored still has per-phase results, and those are the
 * larger part of FR-148's answer. Failing the whole report because a bucket was unreachable would
 * turn a bundle that is provably broken into a validation nobody has a verdict for.
 *
 * Nothing is written when there is no output at all: a run that failed at `bundle_download` never
 * reached `setup.sh`, and an empty object behind a link the panel offers is worse than no link.
 */
const persistOutput = async (input: {
  readonly operations: S3Operations
  readonly bucket: string
  readonly key: string
  readonly output: SanitisedText
  readonly onFailure?: (error: unknown) => void
}): Promise<string | undefined> => {
  if (input.output === '') {
    return undefined
  }

  try {
    await input.operations.putBytes(
      { bucket: input.bucket, key: input.key },
      new TextEncoder().encode(input.output),
    )
    return input.key
  } catch (error) {
    input.onFailure?.(error)
    return undefined
  }
}

/**
 * Prove one bundle and report the result.
 *
 * @param options - The envelope, the environment and the seams.
 * @returns What the surface recorded, the phases as reported, and where the output went.
 * @throws Only when the report itself could not be delivered — a bundle that fails at its first
 *   phase is a *successful* validation run with a `failed` outcome, and resolves.
 */
export const runValidation = async (
  options: RunValidationOptions,
): Promise<ValidationRunOutcome> => {
  const { envelope, environment } = options
  const phaseResults: ValidationPhaseReport[] = []
  let setupOutput: SanitisedText = EMPTY_SANITISED_TEXT

  await prepareWorkspaceRoot(environment.workspaceRoot)

  try {
    const bundle = await runBundleBootstrap({
      bundle: setupBundleReference(envelope.setupBundle, environment.bundlesBucket),
      store: options.archives,
      reporter: collectingReporter(phaseResults),
      bundleDir: options.bundleDir ?? join(environment.workspaceRoot, DEFAULT_BUNDLE_SUBDIRECTORY),
      workspaceRoot: environment.workspaceRoot,
      agentConfigDir: agentConfigDir(environment.workspaceRoot),
      // `SISYPHUS_WORKFLOW_ID` is log correlation only and never a credential — see
      // `bootstrap/bundle.ts`. A validation has no workflow and this instance holds no id for one,
      // so it correlates by the archive it is proving, which is the identifier an operator has.
      workflowId: `validation:${envelope.setupBundle.contentDigest}`,
      // Streamed as well as taken from the result, so output produced before a failing phase threw
      // is still captured. `runBundleBootstrap` only returns `setupOutput` on the success path.
      onOutput: (text) => {
        setupOutput = (setupOutput + text) as SanitisedText
      },
      ...(options.now === undefined ? {} : { now: options.now }),
    })

    setupOutput = bundle.setupOutput
  } catch (thrown) {
    // The failing phase has already been recorded through the reporter above, so there is nothing
    // to add here for a `BootstrapPhaseError` — the report is complete without it. Anything else is
    // a fault in this module rather than in the bundle, and must not be reported as one.
    if (!(thrown instanceof BootstrapPhaseError)) {
      throw thrown
    }
  }

  const outputS3Key = await persistOutput({
    operations: options.operations,
    bucket: environment.logsBucket,
    key: validationOutputKey(envelope.setupBundle.contentDigest, options.token ?? randomUUID()),
    output: setupOutput,
    ...(options.onOutputFailure === undefined ? {} : { onFailure: options.onOutputFailure }),
  })

  const report = await options.client.reportValidation({
    phaseResults,
    ...(outputS3Key === undefined ? {} : { outputS3Key }),
  })

  return { report, phaseResults, ...(outputS3Key === undefined ? {} : { outputS3Key }) }
}

export interface AssembleValidationOptions {
  readonly envelope: ValidationJobEnvelope
  readonly environment: ValidationEnvironment
  /** Injected in tests, so no assembly opens a socket. */
  readonly operations?: S3Operations
  readonly onReportRetry?: (attempt: number, error: unknown) => void
}

/**
 * Build what one validation needs.
 *
 * The counterpart to `assembleRun`, and shorter by everything a validation does not have: no forge,
 * no agent adapter, no frame tap, no snapshot writer, no segment store, no shutdown registrations.
 * The credential is held in a closure for symmetry with `assembleRun` rather than for renewal —
 * nothing renews a validation credential, and `./validate.ts`'s module note says why.
 *
 * @param options - The parsed envelope and the validated environment.
 */
export const assembleValidation = (
  options: AssembleValidationOptions,
): Pick<RunValidationOptions, 'archives' | 'client' | 'operations'> => {
  const { envelope, environment } = options
  const operations = options.operations ?? createS3Operations({ region: environment.region })

  return {
    operations,
    archives: createS3BundleArchiveStore({ operations, bucket: environment.bundlesBucket }),
    client: createValidationSurfaceClient({
      transport: createHttpValidationTransport({
        // The envelope's URL wins: it is the one the credential was minted against.
        url: envelope.machineSurfaceUrl || environment.machineSurfaceUrl,
        credential: () => envelope.scopedCredential,
      }),
      ...(options.onReportRetry === undefined ? {} : { onRetry: options.onReportRetry }),
    }),
  }
}
