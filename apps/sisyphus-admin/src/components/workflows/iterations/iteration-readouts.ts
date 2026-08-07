import type { ReviewFindingInput } from '@bluetel-ai/sisyphus-api/client'

/**
 * Shaping an autonomous run's iterations into the timeline the panel renders (T127, FR-061,
 * FR-062, FR-119).
 *
 * ## What this card answers that `WorkflowTimeline` cannot
 *
 * The lifecycle timeline is a list of state transitions: provisioned, started, corrected, capped.
 * An autonomous run's iterations are a different kind of record — three attempts at the same piece
 * of work, each with a verdict and a list of things wrong with it — and the question a reader
 * arrives with is not "what happened when?" but **"why did it stop, and what is still wrong?"**
 *
 * That question has a specific wrong answer available, which is why the shaping is here rather
 * than in the JSX: a run that failed three times and a run that passed on the third both have
 * three iterations, and a card that showed "3 iterations" would render them identically. So the
 * readouts state the standing in words, and the unresolved findings are computed rather than left
 * for a reader to diff three lists by eye.
 *
 * ## An unresolved finding is one no later pass cleared
 *
 * A blocker raised in iteration one that iterations two and three did not repeat is still
 * unresolved — the reviewer moving on to the next-worst problem is not the first problem being
 * solved. This mirrors `unresolvedFindings` in the executor exactly, and deliberately: the panel
 * showing a different set from the one the run reported would make the two disagree about the same
 * question.
 *
 * ## Nothing here decides anything
 *
 * The run's terminal outcome is the platform's to record. This shapes what is already true; if the
 * outcome and this card ever disagree, the outcome is the record and the disagreement is the bug.
 */

/** A review verdict as the platform records it. */
export type IterationVerdict = 'pass' | 'fail'

/**
 * One iteration as the detail query will return it.
 *
 * This is the *readout* shape, not the row: `verdict` where the column is `reviewVerdict`, and an
 * absent anchor spelled `undefined` where the column is nullable. It is not a hand-written mirror
 * of the procedure — `./iteration-source.ts` derives `IterationPass` from
 * `RouterOutputs['workflow']['iterations']` and converts, so a column renamed in the API is a
 * compile error at that one boundary rather than a field that silently reads `undefined` here.
 */
export interface IterationRecord {
  readonly id: string
  readonly ordinal: number
  readonly verdict: IterationVerdict | null
  readonly startedAt: Date | string | null
  readonly endedAt: Date | string | null
  readonly findings: readonly ReviewFindingInput[]
}

/** One finding, as the card renders it. */
export interface FindingReadouts {
  readonly key: string
  readonly severity: string
  /** `entry · path:line`, or as much of it as the finding carries. */
  readonly location: string
  readonly summary: string
}

/** One iteration, as the card renders it. */
export interface IterationReadouts {
  readonly id: string
  /** `1 of 3`, so the bound is visible without a legend. */
  readonly ordinal: string
  /** `passed`, `failed`, or `in flight` for a pass with no verdict yet. */
  readonly verdict: string
  readonly findingCount: string
  readonly findings: readonly FindingReadouts[]
}

/** The whole loop, as one answer. */
export interface IterationTimelineReadouts {
  readonly iterations: readonly IterationReadouts[]
  /** The chip's readout — `3 of 3`. */
  readout: string
  /** One sentence saying where the loop got to. Always present, even when it passed. */
  readonly statement: string
  /** True when three passes were used and none passed (FR-062). */
  readonly exhausted: boolean
  /** Findings no later pass cleared, newest pass last. */
  readonly unresolved: readonly FindingReadouts[]
}

/** FR-061's hard maximum, shown so a reader can see how much of it was used. */
export const MAX_ITERATIONS = 3

const IN_FLIGHT = 'in flight'

const verdictReadout = (verdict: IterationVerdict | null): string => {
  if (verdict === 'pass') {
    return 'passed'
  }

  return verdict === 'fail' ? 'failed' : IN_FLIGHT
}

const locationOf = (finding: ReviewFindingInput): string => {
  const path =
    finding.filePath === undefined
      ? undefined
      : `${finding.filePath}${finding.line === undefined ? '' : `:${String(finding.line)}`}`

  return [finding.workflowEntryId, path].filter((part) => part !== undefined).join(' · ')
}

const toFindingReadouts = (
  finding: ReviewFindingInput,
  ordinal: number,
  index: number,
): FindingReadouts => ({
  key: `${String(ordinal)}-${String(index)}`,
  severity: finding.severity,
  location: locationOf(finding),
  summary: finding.summary,
})

const plural = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? '' : 's'}`

const statementFor = (
  iterations: readonly IterationRecord[],
  exhausted: boolean,
  unresolved: number,
): string => {
  if (iterations.length === 0) {
    return 'This run has recorded no development iterations.'
  }

  if (iterations.some((iteration) => iteration.verdict === 'pass')) {
    const at = iterations.findIndex((iteration) => iteration.verdict === 'pass') + 1

    return `Review passed on iteration ${String(at)} of ${String(MAX_ITERATIONS)}.`
  }

  if (exhausted) {
    return (
      `All ${String(MAX_ITERATIONS)} iterations were used and none passed review, so the run ` +
      `stopped for a human rather than trying a fourth time. ${plural(unresolved, 'finding')} ` +
      'remain unresolved.'
    )
  }

  return `${plural(iterations.length, 'iteration')} of ${String(MAX_ITERATIONS)} recorded; this run has not finished.`
}

/**
 * Findings no later pass cleared.
 *
 * Everything after the last passing iteration, deduplicated on the finding's own words — a run
 * that passed leaves nothing standing, and a run that never passed leaves every distinct finding
 * it ever raised.
 *
 * @param iterations - Every pass, oldest first.
 */
export const unresolvedFindings = (
  iterations: readonly IterationRecord[],
): readonly FindingReadouts[] => {
  const lastPassing = iterations.findLastIndex((iteration) => iteration.verdict === 'pass')
  const seen = new Set<string>()
  const unresolved: FindingReadouts[] = []

  for (const iteration of iterations.slice(lastPassing + 1)) {
    for (const [index, finding] of iteration.findings.entries()) {
      const readout = toFindingReadouts(finding, iteration.ordinal, index)
      const key = [readout.severity, readout.location, readout.summary].join('|')

      if (!seen.has(key)) {
        seen.add(key)
        unresolved.push(readout)
      }
    }
  }

  return unresolved
}

/**
 * Derive the iteration timeline for one run.
 *
 * @param iterations - Every pass the run recorded, oldest first. The order is the procedure's and
 *   is never re-sorted here: a timeline the panel reordered is no longer the record.
 */
export const toIterationTimelineReadouts = (
  iterations: readonly IterationRecord[],
): IterationTimelineReadouts => {
  const exhausted =
    iterations.length >= MAX_ITERATIONS &&
    !iterations.some((iteration) => iteration.verdict === 'pass')
  const unresolved = unresolvedFindings(iterations)

  return {
    iterations: iterations.map((iteration) => ({
      id: iteration.id,
      ordinal: `${String(iteration.ordinal)} of ${String(MAX_ITERATIONS)}`,
      verdict: verdictReadout(iteration.verdict),
      findingCount: String(iteration.findings.length),
      findings: iteration.findings.map((finding, index) =>
        toFindingReadouts(finding, iteration.ordinal, index),
      ),
    })),
    readout: `${String(iterations.length)} of ${String(MAX_ITERATIONS)}`,
    statement: statementFor(iterations, exhausted, unresolved.length),
    exhausted,
    unresolved,
  }
}
