/**
 * Acting on a verdict — findings posted, and the ticket moved **only** where the skill says so
 * (T129, FR-057, FR-060, FR-063, FR-076, FR-080).
 *
 * ## This is the one place a ticket transition is correct, and the difference is the skill
 *
 * FR-060 forbids a delegated run from moving a ticket at all; FR-063 requires a review workflow to
 * perform "only the ticket transition the skill prescribes". Those look like two rules about two
 * workflow types, and implementing them that way — a `workflowType === 'review'` branch — would be
 * the wrong shape, because the actual rule is simpler and stricter: **a ticket moves when a
 * resolved skill says to move it, and never otherwise.**
 *
 * That reading is what the code enforces, and it enforces FR-060 as a consequence rather than as a
 * special case. A delegated run goes through `src/delivery`, whose `Forge` port has no method that
 * could move a ticket; it never reaches this module, and there is nothing for it to reach. A review
 * run reaches this module and still moves nothing unless `sisyphus-review` produced a directive,
 * which `transitionTicket` requires and will not synthesise.
 *
 * ## Order, and why the ticket goes last
 *
 * Findings first, ticket second. If the comment fails, the run halts having moved nothing — a
 * ticket sitting in a review column with no review on the pull request is a state a human has to
 * unpick, and it looks exactly like a review that found nothing wrong. The reverse failure is
 * benign by comparison: findings posted and the ticket not yet moved reads as a review in progress,
 * which is what it is.
 *
 * Both are guarded (FR-080). The target can merge while the review is being written, and the
 * checkpoint immediately before each irreversible act is what stops the comment landing on a merged
 * diff.
 */

import type { ExternalActionDisposition, ExternalActionLedger } from '../delivery'
import { createExternalActionLedger, performExternalAction } from '../delivery'

import type { ReviewGuard, NoOpReviewOutcome } from './review-guard'
import type { ReviewAssessment, ReviewTarget } from './review-step'
import { transitionTicket, ticketUntouched } from './ticket'
import type {
  TicketPort,
  TicketTransitionRecord,
  TicketTransitionRef,
  TicketUntouchedRecord,
} from './ticket'

/** The action name in the idempotency key for a posted review. */
export const REVIEW_COMMENT_ACTION = 'review-comment'

/** A comment as the forge reports it. */
export interface ReviewCommentRef {
  readonly repository: string
  readonly pullRequestNumber: number
  readonly url: string
}

/**
 * The port that puts findings on a pull request.
 *
 * Separate from `Forge` because `Forge` deliberately cannot write anything a delegated run must not
 * write, and adding a comment method there would give every caller of the delivery path the ability
 * to post one.
 */
export type FindingsPublisher = (input: {
  readonly repository: string
  readonly pullRequestNumber: number
  readonly body: string
  readonly idempotencyKey: string
}) => Promise<ReviewCommentRef>

/** One posted comment and how it was arrived at. */
export interface PostedFindings {
  readonly target: ReviewTarget
  readonly comment: ReviewCommentRef
  readonly disposition: ExternalActionDisposition
}

/** What acting on a verdict produced. */
export interface ReviewOutcomeRecord {
  readonly verdict: ReviewAssessment['verdict']
  readonly posted: readonly PostedFindings[]
  readonly ticket: TicketTransitionRecord | TicketUntouchedRecord
  /** Always false. A review makes no code changes (FR-063). */
  readonly madeCodeChanges: false
  /** Present when a checkpoint stopped the run instead (FR-080). */
  readonly noOp?: NoOpReviewOutcome
}

export interface ApplyReviewOutcomeInput {
  readonly workflowId: string
  readonly assessment: ReviewAssessment
  readonly guard: ReviewGuard
  readonly publisher: FindingsPublisher
  readonly commentLedger: ExternalActionLedger<ReviewCommentRef>
  /** Absent when the run has no ticket, which is legitimate for a review of a stray branch. */
  readonly ticketReference?: string
  readonly ticket?: TicketPort
  readonly ticketLedger?: ExternalActionLedger<TicketTransitionRef>
}

const noOpRecord = (
  assessment: ReviewAssessment,
  noOp: NoOpReviewOutcome,
  posted: readonly PostedFindings[],
  ticketReference: string | undefined,
): ReviewOutcomeRecord => ({
  verdict: assessment.verdict,
  posted,
  ticket: ticketUntouched(ticketReference ?? '', noOp.reason),
  madeCodeChanges: false,
  noOp,
})

/**
 * Post the findings and move the ticket the skill named.
 *
 * @param input - The verdict, the guard, and the two ports.
 * @returns What was posted, what happened to the ticket, and the no-op if one intervened.
 * @throws When the skill prescribed a comment there is no publisher for, or a move with no port.
 */
export const applyReviewOutcome = async (
  input: ApplyReviewOutcomeInput,
): Promise<ReviewOutcomeRecord> => {
  const { assessment } = input

  const beforeFindings = await input.guard.checkpoint('before_findings')

  if (beforeFindings.action === 'stop') {
    return noOpRecord(assessment, beforeFindings.outcome, [], input.ticketReference)
  }

  const posted: PostedFindings[] = []
  const body = assessment.comment

  if (body !== undefined) {
    for (const target of assessment.targets) {
      const outcome = await performExternalAction(input.commentLedger, {
        identity: {
          action: REVIEW_COMMENT_ACTION,
          workflowId: input.workflowId,
          target: [target.repository, String(target.pullRequestNumber)],
          kind: 'comment_posted',
        },
        perform: async (idempotencyKey) =>
          input.publisher({
            repository: target.repository,
            pullRequestNumber: target.pullRequestNumber,
            body,
            idempotencyKey,
          }),
      })

      posted.push({ target, comment: outcome.result, disposition: outcome.disposition })
    }
  }

  if (assessment.ticket === undefined) {
    return {
      verdict: assessment.verdict,
      posted,
      ticket: ticketUntouched(
        input.ticketReference ?? '',
        `${assessment.skill.skillName} prescribes no ticket transition for this verdict, so the ` +
          'ticket was deliberately left where it is (FR-063).',
      ),
      madeCodeChanges: false,
    }
  }

  if (input.ticketReference === undefined || input.ticket === undefined) {
    throw new Error(
      `${assessment.skill.skillName} prescribes a ticket transition but this run has no ticket ` +
        'connector to perform it with. The workflow stops here rather than reporting a review ' +
        'that only half happened.',
    )
  }

  const beforeTicket = await input.guard.checkpoint('before_ticket')

  if (beforeTicket.action === 'stop') {
    return noOpRecord(assessment, beforeTicket.outcome, posted, input.ticketReference)
  }

  const moved = await transitionTicket({
    workflowId: input.workflowId,
    ticketReference: input.ticketReference,
    toState: assessment.ticket.toState,
    directive: assessment.ticket.directive,
    ticket: input.ticket,
    // A caller that wants deduplication across retries owns the ledger; a call-local one
    // deduplicates within this invocation and nothing more, which is the honest scope.
    ledger: input.ticketLedger ?? createExternalActionLedger<TicketTransitionRef>(),
  })

  return { verdict: assessment.verdict, posted, ticket: moved, madeCodeChanges: false }
}
