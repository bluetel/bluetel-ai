import { z } from 'zod'

import {
  ARTIFACT_KINDS,
  BOOTSTRAP_PHASE_OUTCOMES,
  BOOTSTRAP_PHASES,
  ENTRY_RESULTS,
  EXTERNAL_ACTION_KINDS,
  EXTERNAL_ACTION_RESULTS,
  REPORTABLE_CORRECTION_DELIVERY_OUTCOMES,
  REPORTABLE_SUPERVISION_DELIVERY_OUTCOMES,
  REVIEW_FINDING_SEVERITIES,
  REVIEW_VERDICTS,
  SKILL_NAMES,
  SNAPSHOT_BOUNDARIES,
  TERMINAL_OUTCOMES,
  VALIDATION_BOOTSTRAP_PHASES,
  WORKFLOW_STATES,
} from '../enums'

import { moneyAmount, nonEmptyText, uuidInput } from './common'

/**
 * Inputs for the machine surface — everything the executor reports back.
 *
 * None of these carries a `workflowId`. The credential does: every write is scoped to
 * `ctx.workflowId`, and a payload that named its own workflow would invite exactly the
 * cross-workflow write FR-018 makes a recorded security event. Where a workflow must be named
 * (a retry replaying an old envelope), the resolver compares it against the credential rather
 * than trusting it.
 *
 * Every vocabulary these schemas validate against is imported from `src/enums/` and none is
 * declared here. That directory is the single source: it holds plain tuples with no dependencies,
 * so it is reachable from `./client`, and `src/db/schema/enums.ts` builds its `pgEnum`s from the
 * same tuples. There is nothing left to drift, and so nothing left to pin.
 *
 * Two of the imports are the `REPORTABLE_` subsets rather than the full vocabulary, because
 * `pending` is a row's state before anyone has answered and is therefore not something an executor
 * can report about itself.
 */

/** Liveness plus consumption, so a lapsed heartbeat and an exhausted cap look different (FR-048). */
export const heartbeatInput = z.object({
  state: z.enum(WORKFLOW_STATES),
  turnsUsed: z.number().int().nonnegative(),
  spendUsed: moneyAmount,
})

/** Attributable bootstrap progress, so a timeout names the phase that hung (FR-145, FR-146). */
export const reportBootstrapPhaseInput = z.object({
  phase: z.enum(BOOTSTRAP_PHASES),
  entryId: uuidInput.optional(),
  outcome: z.enum(BOOTSTRAP_PHASE_OUTCOMES),
  detail: z.string().optional(),
})

/**
 * One chunk of run output (FR-046).
 *
 * Idempotent on `(workflowId, sequence)`, which is enforced by a unique index rather than by a
 * check here: a retry after a network failure must not be able to duplicate a segment.
 */
export const appendLogSegmentInput = z.object({
  sequence: z.number().int().nonnegative(),
  s3Key: nonEmptyText,
  byteSize: z.number().int().nonnegative(),
  startedAt: z.date(),
  endedAt: z.date(),
})

/**
 * A resumable session snapshot (FR-050, FR-053).
 *
 * Both state flags are required, not optional: a snapshot missing either is not resumable, and
 * discovering that at restore time rather than at registration time means the run is already
 * lost.
 */
export const registerSnapshotInput = z.object({
  sessionId: uuidInput,
  s3Key: nonEmptyText,
  sizeBytes: z.number().int().nonnegative(),
  boundary: z.enum(SNAPSHOT_BOUNDARIES),
  hasConversationState: z.boolean(),
  hasWorktreeState: z.boolean(),
  truncationRepaired: z.boolean().default(false),
})

/**
 * A snapshot boundary the run could not write, and is holding at (FR-082).
 *
 * The counterpart to {@link registerSnapshotInput} and the reason both exist: a snapshot either
 * lands, in which case the run moves on, or it does not, in which case the run **parks** — holds
 * the agent at the turn boundary it already reached, spends no further tokens, keeps heartbeating,
 * and retries the write. Without this input the second case is invisible to everything above the
 * instance, and a run waiting on object storage is indistinguishable from one that has hung.
 *
 * `attempt` is 1-based and is the attempt that **failed**; `attempt + 1` is the one about to be
 * tried. It is reported rather than counted here because the budget lives on the instance
 * (`session/park.ts`) and a count derived server-side from the number of reports received would be
 * wrong exactly when a report was lost — which is when storage is unreachable.
 */
export const reportSnapshotParkInput = z.object({
  boundary: z.enum(SNAPSHOT_BOUNDARIES),
  attempt: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  /** How long the run will wait before the next attempt, so the panel can say when to look again. */
  nextDelayMs: z.number().int().nonnegative(),
  /** Why the write failed, sanitised by the executor. Free text, and therefore optional. */
  detail: z.string().optional(),
})

/**
 * The `workflow_events.detail` discriminator that marks a `parked` entry as a **storage** park.
 *
 * `parked` already carries a second meaning: `reportTerminal` writes it for the `parked_resumable`
 * outcome, which is the opposite situation — the snapshot *did* land and the compute has been
 * released. Both are parks and both belong on the timeline, so the reader needs one field to tell
 * them apart, and this is it. Without the discriminator a panel would have to guess from the
 * detail's shape, and would eventually guess wrong.
 */
export const SNAPSHOT_PARK_WAITING_ON = 'storage'

/**
 * The detail a storage park records, as it is read back off the timeline.
 *
 * A parser rather than a cast: `workflow_events.detail` is `jsonb`, so what comes out is `unknown`
 * and the read path has no compile-time guarantee that the row it found was written by the version
 * of this code that is running. `detail` is nullable here and optional on the input because the
 * column stores an explicit `null` for "no explanation given".
 */
export const snapshotParkDetail = z.object({
  waitingOn: z.literal(SNAPSHOT_PARK_WAITING_ON),
  boundary: z.enum(SNAPSHOT_BOUNDARIES),
  attempt: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  nextDelayMs: z.number().int().nonnegative(),
  detail: z.string().nullable(),
})

export const acknowledgeCorrectionInput = z.object({
  correctionId: uuidInput,
  outcome: z.enum(REPORTABLE_CORRECTION_DELIVERY_OUTCOMES),
  failureReason: z.string().optional(),
})

/** Acknowledging is what makes the panel's "paused" true rather than merely requested (SC-003). */
export const acknowledgeCommandInput = z.object({
  commandId: uuidInput,
  outcome: z.enum(REPORTABLE_SUPERVISION_DELIVERY_OUTCOMES),
  failureReason: z.string().optional(),
})

export const reportSkillReferenceInput = z.object({
  skillName: z.enum(SKILL_NAMES),
  entryId: uuidInput.optional(),
  resolvedPath: z.string().optional(),
  contentDigest: z.string().optional(),
  phase: z.string().optional(),
  unavailableReason: z.string().optional(),
})

export const registerArtifactInput = z.object({
  entryId: uuidInput.optional(),
  kind: z.enum(ARTIFACT_KINDS),
  s3Key: nonEmptyText.optional(),
  externalUrl: z.string().url().optional(),
  byteSize: z.number().int().nonnegative().optional(),
})

/**
 * Per-entry outcome — staleness and success are evaluated per repository (FR-114, FR-115).
 *
 * `stalenessNote` is the prose assessment of whether this entry's base branch advanced during the
 * run (FR-079). It is optional and it is the *only* free-text field here, for two reasons:
 *
 * - **Optional**, because a base branch that could not be read produces `undetermined` rather than
 *   silence, and a run that never assessed staleness must not be forced to invent a note. Absent
 *   means "not assessed"; present means "assessed, and this is what was found".
 * - **A note rather than a verdict**, because FR-079 leaves the decision about what to do with a
 *   stale branch to the repository's own skills. A boolean `isStale` would invite a consumer to
 *   act on it; prose recording what was observed is what the requirement actually asks for.
 */
export const reportEntryResultInput = z.object({
  entryId: uuidInput,
  resolvedCommit: nonEmptyText,
  wasChanged: z.boolean(),
  pullRequestUrl: z.string().url().optional(),
  entryResult: z.enum(ENTRY_RESULTS),
  stalenessNote: nonEmptyText.optional(),
})

/**
 * An action taken outside the platform (FR-076, FR-077).
 *
 * `idempotencyKey` is required: a retried comment that posts twice is visible to the customer,
 * so deduplication cannot be optional.
 */
export const reportExternalActionInput = z.object({
  kind: z.enum(EXTERNAL_ACTION_KINDS),
  targetReference: nonEmptyText,
  idempotencyKey: nonEmptyText,
  result: z.enum(EXTERNAL_ACTION_RESULTS),
  attemptCount: z.number().int().positive(),
})

export const reviewFindingInput = z.object({
  workflowEntryId: uuidInput.optional(),
  filePath: z.string().optional(),
  line: z.number().int().positive().optional(),
  severity: z.enum(REVIEW_FINDING_SEVERITIES),
  summary: nonEmptyText,
})

/** `ordinal` is bounded at three by a check constraint, not by a loop counter (FR-061). */
export const reportIterationInput = z.object({
  ordinal: z.number().int().min(1).max(3),
  verdict: z.enum(REVIEW_VERDICTS),
  findings: z.array(reviewFindingInput).default([]),
})

export const reportReviewerSummaryInput = z.object({ summary: nonEmptyText })

/**
 * The last thing an executor says (FR-056, FR-064).
 *
 * The executor MUST NOT reach a terminal state without calling this; the reconciler exists to
 * catch the case where it dies before it can.
 */
export const reportTerminalInput = z.object({
  outcome: z.enum(TERMINAL_OUTCOMES),
  reason: nonEmptyText,
  turnsUsed: z.number().int().nonnegative(),
  spendUsed: moneyAmount,
})

/** One phase of a bundle validation, as the instance that ran it reports it (FR-147, FR-148). */
export const validationPhaseResultInput = z.object({
  phase: z.enum(VALIDATION_BOOTSTRAP_PHASES),
  outcome: z.enum(BOOTSTRAP_PHASE_OUTCOMES),
  /** Sanitised by the executor before it reaches the wire — `setup.sh` output ends up here. */
  detail: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
})

/**
 * **The result of proving a setup bundle, reported once at the end (T200, FR-147, FR-148).**
 *
 * The only input on this surface validated against a `validationProcedure` rather than a
 * `machineProcedure`, and — like every other input here — it carries no id. The run is
 * `ctx.validationRunId`, taken from the credential, for exactly the reason the header gives: a
 * payload that named its own subject would invite the cross-subject write FR-018 makes a recorded
 * security event, and here it would let one instance overwrite another validation's verdict.
 *
 * ## Three things it deliberately does not carry
 *
 * **No `outcome`.** `passed` and `failed` are *derived* from the phases, in `reportValidation`,
 * because the outcome is a function of the phase results and a wire field would be a second copy of
 * a fact already on the wire — free to contradict it, and the copy an operator reads. The
 * `VALIDATION_OUTCOMES` vocabulary is what the derivation lands in.
 *
 * **No `startedAt`.** The run was recorded by the control plane before the instance existed, and
 * `validation_runs.started_at` is that moment. An instance's clock is not a source of truth about
 * when the platform started something.
 *
 * **No phase this run could not have reached.** `phase` is
 * {@link VALIDATION_BOOTSTRAP_PHASES}, not the full `bootstrap_phase` vocabulary: a validation has
 * no workspace, no prompt and no leased seat, so a report naming `agent_start` would be describing
 * something that did not happen, and accepting it would put that claim in the panel.
 *
 * ## Why phases are an array and not a record, and why they must be distinct
 *
 * An array preserves the order the instance ran them in, which is the order a reader needs to see
 * "it got as far as `bundle_unpack`" — a JSON object's key order is not a guarantee anybody should
 * rely on. Distinctness is checked rather than assumed because two results for one phase have no
 * meaning: a phase runs once per validation, and a duplicate would make "did `setup_script` pass"
 * depend on which entry the reader looked at.
 *
 * Non-empty, because a report with no phases at all says nothing and would end a run with a verdict
 * of `passed` — the one thing an empty report must never be able to do.
 */
export const reportValidationInput = z
  .object({
    phaseResults: z.array(validationPhaseResultInput).min(1),
    /** Where the captured, redacted `setup.sh` output was written (FR-089, FR-148). */
    outputS3Key: nonEmptyText.optional(),
  })
  .refine(
    (input) =>
      new Set(input.phaseResults.map((result) => result.phase)).size === input.phaseResults.length,
    {
      message: 'each bootstrap phase may be reported at most once per validation run',
      path: ['phaseResults'],
    },
  )

export type HeartbeatInput = z.infer<typeof heartbeatInput>
export type ReportBootstrapPhaseInput = z.infer<typeof reportBootstrapPhaseInput>
export type AppendLogSegmentInput = z.infer<typeof appendLogSegmentInput>
export type RegisterSnapshotInput = z.infer<typeof registerSnapshotInput>
export type ReportSnapshotParkInput = z.infer<typeof reportSnapshotParkInput>
export type SnapshotParkDetail = z.infer<typeof snapshotParkDetail>
export type AcknowledgeCorrectionInput = z.infer<typeof acknowledgeCorrectionInput>
export type AcknowledgeCommandInput = z.infer<typeof acknowledgeCommandInput>
export type ReportSkillReferenceInput = z.infer<typeof reportSkillReferenceInput>
export type RegisterArtifactInput = z.infer<typeof registerArtifactInput>
export type ReportEntryResultInput = z.infer<typeof reportEntryResultInput>
export type ReportExternalActionInput = z.infer<typeof reportExternalActionInput>
export type ReviewFindingInput = z.infer<typeof reviewFindingInput>
export type ReportIterationInput = z.infer<typeof reportIterationInput>
export type ReportReviewerSummaryInput = z.infer<typeof reportReviewerSummaryInput>
export type ReportTerminalInput = z.infer<typeof reportTerminalInput>
export type ValidationPhaseResultInput = z.infer<typeof validationPhaseResultInput>
export type ReportValidationInput = z.infer<typeof reportValidationInput>
