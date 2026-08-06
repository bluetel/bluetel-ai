/**
 * What an autonomous run does when it has used all three iterations (T125, FR-062, FR-064).
 *
 * FR-062: a run that exhausts its three iterations without a passing review stops, is marked as
 * needing human attention, and **surfaces the unresolved review findings**.
 *
 * ## The two wrong answers this module exists to rule out
 *
 * - **Trying again.** A fourth pass is the tempting one because the loop is right there and the
 *   next attempt is cheap to write. It is not cheap to run: it costs another full development pass
 *   against a ticket three reviews have already rejected, and it will not converge, because
 *   nothing about the fourth attempt is different from the third. `nextOrdinal` answers
 *   `undefined` rather than `4` precisely so there is no number to loop on, and the check
 *   constraint behind `reportIteration` refuses the row regardless.
 * - **Throwing the history away.** A run that ends `needs_attention` with only "three iterations
 *   failed" recorded hands a human the least useful possible artefact: they know it did not work
 *   and nothing about why. The whole history is preserved — every pass, its verdict, and every
 *   finding — and the unresolved findings are surfaced separately, because the question a human
 *   arrives with is "what is actually wrong?" rather than "how many times did it try?".
 *
 * ## Why the outcome is `needs_attention` and not `failed`
 *
 * The run did what it was asked to do. It developed, it reviewed, it fed the findings back, three
 * times, and the work is sitting on a branch with an open pull request and a complete review
 * history attached. That is a handover, not a failure — and FR-064's vocabulary has a word for it.
 * Recording `failed` would suggest the run broke, and would put it in the same bucket as a run
 * whose instance died at bootstrap, which is a different conversation entirely.
 */

import type { IterationFinding, IterationHistory } from './iteration-record'
import { hasPassed, isExhausted, MAX_ITERATIONS, unresolvedFindings } from './iteration-record'

/** The FR-064 outcome an exhausted run reaches. */
export const EXHAUSTION_OUTCOME = 'needs_attention'

/** What an exhausted run hands to a human. */
export interface ExhaustionReport {
  readonly outcome: typeof EXHAUSTION_OUTCOME
  readonly reason: string
  /**
   * Every pass, in order, exactly as it was recorded. Not a count and not a summary: the run's
   * own history is the artefact a human needs, and reducing it here would lose the only copy the
   * report carries.
   */
  readonly history: IterationHistory
  /** The findings no pass resolved, which is the question a human actually arrives with. */
  readonly unresolved: readonly IterationFinding[]
  /** True. Stated positively so a reader is not inferring it from the absence of a fourth pass. */
  readonly stoppedWithoutRetrying: true
}

const countOf = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? '' : 's'}`

/**
 * Whether the run must stop for a human rather than start another pass.
 *
 * True when three passes are on record and none of them passed. A run that passed is not
 * exhausted however many passes it took, and a run with fewer than three has another to give.
 *
 * @param history - Every pass so far.
 */
export const mustStopForAttention = (history: IterationHistory): boolean =>
  isExhausted(history) && !hasPassed(history)

/**
 * The refusal for a caller that reached for a fourth pass anyway.
 *
 * Named and exported so the loop has something to throw that is not a generic error, and so a test
 * can assert on the specific case rather than on "it threw".
 */
export const fourthIterationRefused = (history: IterationHistory): Error =>
  new Error(
    `This run has completed ${countOf(history.length, 'iteration')} without a passing review and ` +
      `will not attempt another: FR-061 bounds an autonomous run at ${String(MAX_ITERATIONS)}. ` +
      'It stops for human attention with its iteration history intact.',
  )

/**
 * Build the report an exhausted run terminates with.
 *
 * @param history - Every pass the run completed, oldest first.
 * @returns The outcome, the reason, the intact history, and the unresolved findings.
 * @throws When the run is not actually exhausted, so a run with a pass left cannot be stopped by
 *   calling the wrong function.
 */
export const exhaustionReport = (history: IterationHistory): ExhaustionReport => {
  if (!mustStopForAttention(history)) {
    throw new Error(
      `This run is not exhausted: ${countOf(history.length, 'iteration')} recorded and ` +
        `${hasPassed(history) ? 'one of them passed' : 'it has another to give'}. Reaching for ` +
        'the exhaustion path here would end a run that is not finished.',
    )
  }

  const unresolved = unresolvedFindings(history)

  return {
    outcome: EXHAUSTION_OUTCOME,
    reason:
      `Three development iterations were completed and none passed review (FR-062). The work, ` +
      `its pull requests and all ${countOf(history.length, 'review')} are recorded; ` +
      `${countOf(unresolved.length, 'finding')} remain unresolved and are listed with this run. ` +
      'A fourth iteration was not attempted.',
    history,
    unresolved,
    stoppedWithoutRetrying: true,
  }
}
