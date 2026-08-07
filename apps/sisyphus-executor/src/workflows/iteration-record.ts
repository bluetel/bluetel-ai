/**
 * The iteration ledger the autonomous loop runs against (T123, T124, FR-061, FR-062, FR-119).
 *
 * ## The bound is not here, and that is deliberate
 *
 * {@link MAX_ITERATIONS} is stated so this file can *stop asking* — not so it can be the thing
 * that says no. FR-061's hard maximum is a check constraint on `iterations.ordinal`
 * (`iterations_ordinal_bounds`), and the reason it lives there rather than in a counter is that
 * the executor is not one continuous process: a run is snapshotted and restored, an instance is
 * reclaimed and replaced, a report is retried after a lost response. Every one of those loses or
 * double-counts an in-memory count, and the failure it produces is a fourth pass spending real
 * money on a ticket that has already failed review three times.
 *
 * So {@link recordIteration} does not decide. It reports, and it treats a refusal from the
 * platform as final rather than retryable — which is the behaviour that actually matters, because
 * a caller that retried a bound it can never satisfy is a caller in a loop.
 *
 * ## What the history is for
 *
 * FR-062 requires an exhausted run to surface its **unresolved** findings, and that is a question
 * about the whole history rather than about the last pass: a blocker raised in iteration one,
 * unmentioned in two and three because the reviewer moved on, is precisely what a human needs. So
 * the history is accumulated in full — every pass, every finding, in order — and nothing here
 * prunes it. `exhausted.ts` reads it.
 */

import type { ReviewFindingInput } from '@bluetel-ai/sisyphus-api/client'

/** FR-061's hard maximum. The authority is the check constraint; this is when to stop asking. */
export const MAX_ITERATIONS = 3

/** A review verdict, as the platform records it. */
export type IterationVerdict = 'pass' | 'fail'

/** One finding, anchored to entry, file and line so a multi-repo run stays legible (FR-119). */
export type IterationFinding = ReviewFindingInput

/** One completed pass, as it is reported and as it is remembered. */
export interface IterationRecord {
  /** 1-based. Bounded at {@link MAX_ITERATIONS} by the database. */
  readonly ordinal: number
  readonly verdict: IterationVerdict
  readonly findings: readonly IterationFinding[]
}

/**
 * How a pass reaches the platform.
 *
 * A port rather than the machine client itself, because `src/report` does not carry
 * `reportIteration` and this directory may not add it. The executor's wiring supplies one; the
 * loop is testable without a network either way.
 */
export type IterationReporter = (record: IterationRecord) => Promise<void>

/** The passes a run has completed, oldest first. */
export type IterationHistory = readonly IterationRecord[]

/** The refusal for a pass beyond the bound, raised before anything is spent on it. */
export const iterationBoundError = (ordinal: number): Error =>
  new Error(
    `Iteration ${String(ordinal)} will not be attempted: an autonomous run is bounded at ` +
      `${String(MAX_ITERATIONS)} development iterations (FR-061). The run stops for human ` +
      'attention with its iteration history intact rather than trying again.',
  )

/**
 * The ordinal of the next pass, or `undefined` when there is none.
 *
 * `undefined` rather than a number the caller has to compare: an interface that answers "4" invites
 * a caller to use it, and the only correct thing to do with a fourth pass is not to start it.
 *
 * @param history - What the run has completed so far.
 */
export const nextOrdinal = (history: IterationHistory): number | undefined =>
  history.length >= MAX_ITERATIONS ? undefined : history.length + 1

/** Whether the run has used every pass it is allowed (FR-062). */
export const isExhausted = (history: IterationHistory): boolean => history.length >= MAX_ITERATIONS

/** Whether any pass passed review. */
export const hasPassed = (history: IterationHistory): boolean =>
  history.some((pass) => pass.verdict === 'pass')

/**
 * Report a completed pass and add it to the history.
 *
 * @param history - The passes so far.
 * @param record - The pass just completed.
 * @param report - How it reaches the platform.
 * @returns The history including this pass.
 * @throws {Error} When the ordinal is beyond the bound, before the platform is troubled with it.
 */
export const recordIteration = async (
  history: IterationHistory,
  record: IterationRecord,
  report: IterationReporter,
): Promise<IterationHistory> => {
  if (record.ordinal < 1 || record.ordinal > MAX_ITERATIONS) {
    throw iterationBoundError(record.ordinal)
  }

  await report(record)

  return [...history, record]
}

/**
 * Every finding a run stopped without resolving (FR-062).
 *
 * Two decisions, each with a plausible wrong answer:
 *
 * - **A passing review clears the ones before it.** Once a pass passes, the findings that failed
 *   the earlier ones were addressed — that is what passing means — so re-surfacing them would
 *   hand a human a list of things that are already fixed, and a list like that is one nobody reads
 *   twice.
 * - **A run that never passed leaves all of them standing**, including a blocker raised in
 *   iteration one that the later reviews did not repeat. Reporting only the last pass's findings
 *   is the failure this function exists to avoid: a reviewer moving on to the next-worst problem
 *   is not the first problem being solved.
 *
 * Deduplicated on the finding's own words, because the executor mints no identifier for one — a
 * finding's identity is its row, assigned by the platform. Two passes describing the same defect
 * identically collapse; two describing it differently are two things worth reading.
 *
 * @param history - The whole run, oldest pass first.
 */
export const unresolvedFindings = (history: IterationHistory): readonly IterationFinding[] => {
  const lastPassing = history.findLastIndex((pass) => pass.verdict === 'pass')
  const seen = new Set<string>()
  const unresolved: IterationFinding[] = []

  for (const pass of history.slice(lastPassing + 1)) {
    for (const finding of pass.findings) {
      const key = [
        finding.severity,
        finding.workflowEntryId ?? '',
        finding.filePath ?? '',
        String(finding.line ?? ''),
        finding.summary,
      ].join('|')

      if (!seen.has(key)) {
        seen.add(key)
        unresolved.push(finding)
      }
    }
  }

  return unresolved
}
