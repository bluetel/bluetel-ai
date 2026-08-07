/**
 * **The SC-003 arithmetic, as numbers rather than as a comment (T090).**
 *
 * SC-003: *a pause takes effect within 10 seconds of the request in at least 99% of attempts, and in
 * no case terminates the run or loses work already produced.* "Takes effect" is the moment the user
 * is told the run is paused, and FR-049 puts that **after** the snapshot is registered — so every
 * term below is inside the budget, snapshot included. There is no reading of SC-003 under which the
 * panel may say "paused" before the working tree is safe.
 *
 * The pause path has five terms, and the poll interval is only the first of them:
 *
 * | Term                          | Budget   | What it is                                                  |
 * | ----------------------------- | -------- | ----------------------------------------------------------- |
 * | {@link POLL_INTERVAL_MS}      | 2000 ms  | Worst case: the row lands the instant after a poll returned  |
 * | {@link PULL_ROUND_TRIP_MS}    | 1000 ms  | `pullPendingCommands` over the machine surface               |
 * | {@link QUIESCE_BUDGET_MS}     | 4000 ms  | Waiting for the agent to reach a turn boundary               |
 * | {@link SNAPSHOT_BUDGET_MS}    | 1500 ms  | Capture and `registerSnapshot`                               |
 * | {@link ACKNOWLEDGE_BUDGET_MS} | 500 ms   | `acknowledgeCommand` — the moment the panel may say "paused" |
 * | **total**                     | 9000 ms  | 1000 ms inside SC-003's ten seconds                          |
 *
 * ## Where the slack is, and why it is where it is
 *
 * The held-back second is not spread across the terms; it sits at the end, unallocated. Two things
 * eat it in practice: the poll timer is a `setTimeout`, so it is a *lower* bound rather than a
 * schedule, and the two round trips are over a network the executor retries on (FR-047). Spreading
 * the slack across the terms would make each one individually generous and the total exactly ten
 * seconds, which is the same thing as having none.
 *
 * ## Why quiesce gets the largest share
 *
 * Because it is the only term that waits on something the platform does not control. It is also the
 * term that gives the requirement its teeth: **the pause budget bounds how long a single turn may
 * run before reaching a boundary.** A turn that takes longer than {@link QUIESCE_BUDGET_MS} makes
 * SC-003 unmeetable no matter how fast everything else is, which is why the adapter's `quiesce`
 * rejects with `quiesce-timeout` rather than waiting — the caller must not snapshot mid-turn on the
 * assumption that a boundary was reached.
 *
 * ## The term that can overrun, stated plainly
 *
 * {@link SNAPSHOT_BUDGET_MS} is optimistic for a large working tree and impossible if durable
 * storage is unreachable. That case is not a missed deadline pretending to be met: the run **parks**
 * (`session/park.ts`, FR-082), the workflow reports a distinct parked reason, and the panel says
 * "waiting on storage" rather than showing a stalled pause. SC-003 asks for ten seconds in 99% of
 * attempts, and the remaining 1% is this — visibly parked, never silently late, and never allowed
 * to advance without a snapshot.
 */

/** SC-003's ceiling. Every budget below is a share of this. */
export const PAUSE_LATENCY_CEILING_MS = 10_000

/**
 * How often the executor collects supervision commands.
 *
 * Two seconds, not five, and not two hundred milliseconds. Five would consume half the budget in the
 * first term alone; two hundred would put 300 requests a minute on the machine surface for every
 * live run, to shave 1.8 seconds off a term that already fits. The queue's partial index on pending
 * rows is what keeps this cheap enough to run at this rate.
 */
export const POLL_INTERVAL_MS = 2_000

/** One `pullPendingCommands` round trip over the machine surface. */
export const PULL_ROUND_TRIP_MS = 1_000

/** Waiting for a turn boundary. The dominant term, and the one that bounds turn length. */
export const QUIESCE_BUDGET_MS = 4_000

/** Capturing the workspace archive and registering it against the workflow (FR-050). */
export const SNAPSHOT_BUDGET_MS = 1_500

/** `acknowledgeCommand` — after which, and only after which, the panel may say "paused". */
export const ACKNOWLEDGE_BUDGET_MS = 500

/** One named term of the pause path. */
export interface LatencyTerm {
  readonly name: string
  readonly budgetMs: number
  readonly what: string
}

/** The whole arithmetic, so a test can check it rather than a reader checking a comment. */
export interface PauseLatencyBudget {
  readonly terms: readonly LatencyTerm[]
  readonly totalMs: number
  readonly ceilingMs: number
  /** Ceiling minus total. Zero or negative means SC-003 is not met on paper, let alone in fact. */
  readonly slackMs: number
}

/**
 * The pause path, term by term.
 *
 * A function rather than a constant so the sum is computed from the terms. A hand-written total
 * would be a number that stops matching the constants the moment one of them is tuned, which is
 * exactly when somebody is relying on it.
 */
export const pauseLatencyBudget = (): PauseLatencyBudget => {
  const terms: readonly LatencyTerm[] = [
    {
      name: 'poll-interval',
      budgetMs: POLL_INTERVAL_MS,
      what: 'worst case: the command row lands the instant after a poll returned',
    },
    {
      name: 'pull-round-trip',
      budgetMs: PULL_ROUND_TRIP_MS,
      what: 'collecting the command over the machine surface',
    },
    {
      name: 'quiesce',
      budgetMs: QUIESCE_BUDGET_MS,
      what: 'waiting for the agent to reach a turn boundary without terminating it',
    },
    {
      name: 'snapshot',
      budgetMs: SNAPSHOT_BUDGET_MS,
      what: 'capturing the workspace and registering the snapshot against the workflow',
    },
    {
      name: 'acknowledge',
      budgetMs: ACKNOWLEDGE_BUDGET_MS,
      what: 'reporting the acknowledgement, after which the panel may say paused',
    },
  ]

  const totalMs = terms.reduce((sum, term) => sum + term.budgetMs, 0)

  return {
    terms,
    totalMs,
    ceilingMs: PAUSE_LATENCY_CEILING_MS,
    slackMs: PAUSE_LATENCY_CEILING_MS - totalMs,
  }
}
