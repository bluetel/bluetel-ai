/**
 * The `ReviewerPort`, implemented against a live agent (T196, FR-057, FR-058, FR-061, FR-063,
 * FR-119, US4, US5).
 *
 * `runReviewStep` resolves `sisyphus-review` and then asks a function for a verdict. This is that
 * function, and until it existed both `runReviewWorkflow` and the autonomous loop's review leg
 * halted at an absent port — two of this feature's user stories with no implementation behind them.
 *
 * ## One port, two callers, and that is the point
 *
 * The autonomous loop's review and the standalone review workflow are the same evaluation against
 * the same skill; `review-step.ts` says so and shares the step between them. Sharing the *port* is
 * the other half of that: two implementations of "ask the agent to review" would drift, and the
 * drift would show up as an autonomous run and a manual review of the same pull request disagreeing
 * about the same rubric.
 *
 * ## The one rule, again
 *
 * Every field of the verdict comes from something the agent wrote. There is no path here that
 * produces a verdict from silence, from a truncated block or from a stream that ended, and a
 * `pass` invented by any of them would merge unreviewed work. What this module will not do is more
 * important than what it does:
 *
 * - It **never** synthesises `pass`. A review that did not answer is reported as
 *   {@link AgentReviewError} and the run fails; `runReviewStep` halts separately on a block that
 *   arrived carrying no verdict.
 * - It **never** downgrades a finding it cannot read. See `review-proposal.ts`: a severity outside
 *   the platform's four is a halt rather than an `info`.
 */

import { randomUUID } from 'node:crypto'

import type { ReviewerPort, ReviewProposal, ReviewRequest } from '../workflows'

import type { AgentAdapter } from './adapter'
import type { FrameTap } from './frame-tap'
import { readReviewProposal } from './review-proposal'
import { REVIEW_TAG, reviewTurnBody } from './review-turn'
import type { AgentAnswerFailure } from './structured-turn'
import { askAgentForBlock } from './structured-turn'

/**
 * A backstop, not a schedule.
 *
 * Shorter than a development pass's, and deliberately: a review reads a diff and writes a comment,
 * where a pass writes code. Long enough that a careful reviewer working through a large
 * cross-repository change is never cut off, short enough that a conversation which has gone
 * permanently quiet does not hold an instance for the best part of an hour.
 */
export const DEFAULT_REVIEW_DEADLINE_MS = 20 * 60_000

/** How a review with no answer is described to whoever reads the terminal report. */
const ANSWER_NOUN = 'review block'

/** Why a review produced no verdict. The transport's failures, plus this port's own two. */
export type AgentReviewFailure =
  | AgentAnswerFailure
  /** A block that parsed and carries none of a review's fields. */
  | 'empty'
  /** A block that parsed and states something that cannot be recorded as a review. */
  | 'unusable'

export class AgentReviewError extends Error {
  readonly kind: AgentReviewFailure

  constructor(options: { readonly kind: AgentReviewFailure; readonly detail: string }) {
    super(
      `the review produced no usable verdict: ${options.detail}. Nothing is assumed about what ` +
        'the agent found — a verdict composed here would either merge unreviewed work or fail a ' +
        'pass that was never looked at (FR-057, FR-058, FR-063).',
    )
    this.name = 'AgentReviewError'
    this.kind = options.kind
  }
}

export interface AgentReviewerPortOptions {
  /** The live conversation. Only `sendTurn`: this port never starts or stops the agent. */
  readonly agent: Pick<AgentAdapter, 'sendTurn'>
  /** Frames as the run's own consumer pulls them; see `frame-tap.ts`. */
  readonly frames: Pick<FrameTap, 'subscribe'>
  readonly deadlineMs?: number
  readonly settleMs?: number
  readonly turnTimeoutMs?: number
  /** Injected in tests, so a transcript can be written by hand. Random otherwise. */
  readonly nonce?: () => string
}

/**
 * Build the reviewer port for a running agent.
 *
 * @param options - The live conversation and the tap on its frames.
 * @returns A `ReviewerPort` for `runReviewStep`, `reviewPullRequestSet` and both workflow types
 *   that review.
 */
export const createAgentReviewerPort = (options: AgentReviewerPortOptions): ReviewerPort => {
  const newNonce = options.nonce ?? ((): string => randomUUID())

  return async (request: ReviewRequest): Promise<ReviewProposal> => {
    const nonce = newNonce()

    const answer = await askAgentForBlock({
      agent: options.agent,
      frames: options.frames,
      tag: REVIEW_TAG,
      nonce,
      body: reviewTurnBody({ request, nonce }),
      answerNoun: ANSWER_NOUN,
      deadlineMs: options.deadlineMs ?? DEFAULT_REVIEW_DEADLINE_MS,
      ...(options.settleMs === undefined ? {} : { settleMs: options.settleMs }),
      ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
    })

    if (answer.kind === 'failed') {
      throw new AgentReviewError({ kind: answer.failure, detail: answer.detail })
    }

    const reading = readReviewProposal(answer.value)

    if (reading.kind === 'empty') {
      throw new AgentReviewError({
        kind: 'empty',
        detail:
          'the agent emitted a well-formed review block carrying none of the fields a review is ' +
          'made of',
      })
    }

    if (reading.kind === 'unusable') {
      throw new AgentReviewError({
        kind: 'unusable',
        detail: `the review block states something that cannot be recorded — ${reading.problems.join('; ')}`,
      })
    }

    return reading.proposal
  }
}
