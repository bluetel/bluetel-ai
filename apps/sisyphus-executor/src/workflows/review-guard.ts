/**
 * The guard against reviewing a target that is already gone (T130, FR-080).
 *
 * ## The failure this prevents
 *
 * A review workflow is queued, an instance is provisioned, and somewhere in the minutes that takes
 * the pull request is merged — or closed because the author changed their mind. The review then
 * runs anyway and posts a page of findings against a merged diff, moves the ticket back out of
 * done, and asks a human to act on work that no longer exists. Every one of those is visible to
 * the customer and none of them is undoable, which is why FR-080 makes the no-op an **outcome**
 * rather than an error: the run did the correct thing, and the correct thing was nothing.
 *
 * ## Why it is a checkpoint rather than a single check at the start
 *
 * FR-080 is written about the state before the run starts, and that check alone is not enough. The
 * window between "the target was open when we looked" and "we are about to post a comment" is the
 * whole review — minutes of it — and the merge that makes the comment pointless is most likely to
 * happen precisely while the review is in flight. So the guard is asked again immediately before
 * each irreversible act. It reports the change at that checkpoint and stops; it does not roll
 * anything back, because there is nothing to roll back — the point of asking at the checkpoint is
 * that nothing has happened yet.
 *
 * ## What it never does
 *
 * It performs no action of its own: no comment, no ticket transition, no code change. The
 * {@link ReviewTargetProbe} it is given is a read. That is the whole of its authority, and it is
 * what makes "posting no comments and performing no ticket transition" a property of the type
 * rather than a promise in a comment.
 */

import type { ReviewTarget } from './review-step'

/** What the forge says about a pull request. `unknown` is a probe that could not answer. */
export type ReviewTargetState = 'open' | 'closed' | 'merged' | 'unknown'

/** The states that mean there is nothing left to review. */
export const DEAD_TARGET_STATES = ['closed', 'merged'] as const

export type DeadTargetState = (typeof DEAD_TARGET_STATES)[number]

export const isDeadTargetState = (state: ReviewTargetState): state is DeadTargetState =>
  (DEAD_TARGET_STATES as readonly string[]).includes(state)

/**
 * The named points at which the guard is consulted.
 *
 * Named rather than positional so the outcome can say *where* the run stopped — "the target was
 * merged before we posted" and "the target was merged before we started" are different facts about
 * the same run, and a reader deciding whether the review was wasted needs to tell them apart.
 */
export const REVIEW_CHECKPOINTS = ['start', 'before_findings', 'before_ticket'] as const

export type ReviewCheckpoint = (typeof REVIEW_CHECKPOINTS)[number]

/** A read against the forge. The only capability this module has. */
export type ReviewTargetProbe = (target: ReviewTarget) => Promise<ReviewTargetState>

/** One target, and what it turned out to be. */
export interface ObservedTarget {
  readonly target: ReviewTarget
  readonly state: ReviewTargetState
}

/**
 * The no-op FR-080 asks for.
 *
 * `succeeded` rather than `failed` or `needs_attention`, and the choice is deliberate: the run was
 * asked to review a pull request, it established that there is no longer one to review, and it
 * stopped without touching anything. Nothing went wrong and nothing needs a human, so recording it
 * as a failure would put a red run in front of somebody with nothing for them to do — and a panel
 * full of those is a panel people stop reading. The reason field is where the no-op is stated, in
 * words, so it never reads as ordinary success.
 */
export interface NoOpReviewOutcome {
  readonly outcome: 'succeeded'
  readonly reason: string
  readonly checkpoint: ReviewCheckpoint
  readonly dead: readonly ObservedTarget[]
  /** Always zero. FR-080 forbids a comment on a dead target. */
  readonly commentsPosted: 0
  /** Always false. FR-080 forbids a transition on a dead target. */
  readonly ticketTransitioned: false
}

export type ReviewGuardDecision =
  | { readonly action: 'continue'; readonly observed: readonly ObservedTarget[] }
  | { readonly action: 'stop'; readonly outcome: NoOpReviewOutcome }

export interface ReviewGuard {
  /**
   * Ask whether the run may take the next irreversible step.
   *
   * @param checkpoint - Where in the workflow this is being asked.
   */
  readonly checkpoint: (checkpoint: ReviewCheckpoint) => Promise<ReviewGuardDecision>
}

const describe = (observed: ObservedTarget): string =>
  `${observed.target.repository}#${String(observed.target.pullRequestNumber)} is ${observed.state}`

const reasonFor = (checkpoint: ReviewCheckpoint, dead: readonly ObservedTarget[]): string => {
  const listed = dead.map(describe).join('; ')

  return checkpoint === 'start'
    ? `No-op: ${listed}. There was nothing left to review when this run started, so no findings ` +
        'were posted and no ticket was moved (FR-080).'
    : `No-op: ${listed}. The target changed while this run was in flight and the change was ` +
        `caught at the ${checkpoint} checkpoint, so no findings were posted and no ticket was ` +
        'moved (FR-080).'
}

/**
 * Build a guard over the run's targets.
 *
 * A probe that cannot answer reports `unknown`, and `unknown` is **not** treated as dead: refusing
 * to review because the forge was briefly unreachable would turn an outage into a run that did
 * nothing and called it success. A probe that throws propagates, for the same reason — "could not
 * ask" is not "nothing there".
 *
 * @param options - The targets and the read.
 */
export const createReviewGuard = (options: {
  readonly targets: readonly ReviewTarget[]
  readonly probe: ReviewTargetProbe
}): ReviewGuard => ({
  checkpoint: async (checkpoint) => {
    const observed: ObservedTarget[] = []

    for (const target of options.targets) {
      observed.push({ target, state: await options.probe(target) })
    }

    const dead = observed.filter((entry) => isDeadTargetState(entry.state))

    if (dead.length === 0) {
      return { action: 'continue', observed }
    }

    return {
      action: 'stop',
      outcome: {
        outcome: 'succeeded',
        reason: reasonFor(checkpoint, dead),
        checkpoint,
        dead,
        commentsPosted: 0,
        ticketTransitioned: false,
      },
    }
  },
})

/**
 * A guard that always continues, for a caller with nothing to guard.
 *
 * Exported so the autonomous loop — which has just opened its own pull requests and therefore
 * knows they are open — does not have to pass `undefined` and does not have to invent a probe.
 */
export const openTargetGuard = (targets: readonly ReviewTarget[]): ReviewGuard =>
  createReviewGuard({ targets, probe: async () => Promise.resolve('open') })
