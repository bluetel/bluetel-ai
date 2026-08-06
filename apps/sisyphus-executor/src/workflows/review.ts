/**
 * The **review** workflow type (T128, FR-063, FR-080, FR-119).
 *
 * A review run evaluates a pull request per `sisyphus-review`, posts its findings, records its
 * verdict, performs only the ticket transition the skill prescribes, and **makes no code changes**.
 *
 * ## "Makes no code changes" is a shape, not a promise
 *
 * The last clause is the one worth engineering rather than asserting. This function takes no
 * developer port, no git writer and no delivery path — there is no argument on {@link
 * RunReviewWorkflowInput} through which a change could be made, so a future edit that wanted to
 * make one would have to widen the signature, which is a conspicuous diff. `madeCodeChanges: false`
 * on the record is the positive statement of the same fact, so the panel can say the code was left
 * alone deliberately rather than leaving a reader to infer it from an absence.
 *
 * ## Always a set
 *
 * The evaluation goes through `review-set.ts` whether the run has one target or five. A single
 * pull request is a set of one, and keeping the multi-entry case (FR-119) on the same code path is
 * what stops it becoming the branch nobody exercises.
 *
 * ## The guard wraps the whole run
 *
 * FR-080's no-op is checked before anything is read and again immediately before each irreversible
 * act. The one at the start is the requirement as written; the later ones exist because the target
 * can merge while the review is being written, and a comment on a merged diff is just as visible to
 * the customer as one posted at the start.
 */

import type { ExternalActionLedger } from '../delivery'
import type { SkillReferenceReporter, SkillSource } from '../skills'

import type { NoOpReviewOutcome, ReviewGuard } from './review-guard'
import type { FindingsPublisher, ReviewCommentRef, ReviewOutcomeRecord } from './review-outcome'
import { applyReviewOutcome } from './review-outcome'
import type { ReviewSetAssessment } from './review-set'
import { reviewPullRequestSet } from './review-set'
import type { ReviewerPort, ReviewTarget } from './review-step'
import type { TicketPort, TicketTransitionRef } from './ticket'

export interface RunReviewWorkflowInput {
  readonly workflowId: string
  /** The primary entry's skills, and nowhere else (FR-110). */
  readonly source: SkillSource
  readonly report: SkillReferenceReporter
  readonly reviewer: ReviewerPort
  readonly guard: ReviewGuard
  readonly targets: readonly ReviewTarget[]
  readonly publisher: FindingsPublisher
  readonly commentLedger: ExternalActionLedger<ReviewCommentRef>
  readonly ticketReference?: string
  readonly ticket?: TicketPort
  readonly ticketLedger?: ExternalActionLedger<TicketTransitionRef>
}

/** What a review run ended up doing. */
export interface ReviewWorkflowResult {
  /** The FR-064 outcome this run reaches. */
  readonly outcome: 'succeeded'
  readonly reason: string
  /** Absent when the run stopped at a checkpoint before reviewing anything (FR-080). */
  readonly assessment?: ReviewSetAssessment
  /** Absent for the same reason. */
  readonly applied?: ReviewOutcomeRecord
  /** Present when a checkpoint stopped the run. */
  readonly noOp?: NoOpReviewOutcome
  /** Always false — this workflow type has nothing to change code with (FR-063). */
  readonly madeCodeChanges: false
}

const reasonFor = (assessment: ReviewSetAssessment, applied: ReviewOutcomeRecord): string => {
  if (applied.noOp !== undefined) {
    return applied.noOp.reason
  }

  const scope =
    assessment.targetCount === 1
      ? 'the pull request'
      : `all ${String(assessment.targetCount)} pull requests together`

  return (
    `Reviewed ${scope} per ${assessment.skill.skillName} and recorded a "${assessment.verdict}" ` +
    `verdict with ${String(assessment.findings.length)} finding(s). No code was changed.`
  )
}

/**
 * Run a review workflow end to end.
 *
 * @param input - The targets, the skills, and the two write ports.
 * @returns The verdict, what was posted, and what happened to the ticket.
 */
export const runReviewWorkflow = async (
  input: RunReviewWorkflowInput,
): Promise<ReviewWorkflowResult> => {
  const start = await input.guard.checkpoint('start')

  if (start.action === 'stop') {
    return {
      outcome: 'succeeded',
      reason: start.outcome.reason,
      noOp: start.outcome,
      madeCodeChanges: false,
    }
  }

  const assessment = await reviewPullRequestSet({
    source: input.source,
    report: input.report,
    reviewer: input.reviewer,
    targets: input.targets,
  })

  const applied = await applyReviewOutcome({
    workflowId: input.workflowId,
    assessment,
    guard: input.guard,
    publisher: input.publisher,
    commentLedger: input.commentLedger,
    ...(input.ticketReference === undefined ? {} : { ticketReference: input.ticketReference }),
    ...(input.ticket === undefined ? {} : { ticket: input.ticket }),
    ...(input.ticketLedger === undefined ? {} : { ticketLedger: input.ticketLedger }),
  })

  return {
    outcome: 'succeeded',
    reason: reasonFor(assessment, applied),
    assessment,
    applied,
    ...(applied.noOp === undefined ? {} : { noOp: applied.noOp }),
    madeCodeChanges: false,
  }
}
