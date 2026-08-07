/**
 * **Park and retry at a snapshot boundary (T092, FR-082).**
 *
 * The snapshot step of `suspend()` can fail, and it must not be allowed to lose work. If durable
 * storage is unreachable the run has exactly three options and two of them are wrong:
 *
 * - *continue without a snapshot* — the run advances past a point it can no longer be recovered to, which
 *   is the failure FR-082 names;
 * - *terminate* — throws away work that is sitting on disk and is perfectly good;
 * - *park and retry* — hold at the boundary already reached and keep trying the write.
 *
 * ## Why parking is cheap and why that matters
 *
 * Parking holds the agent **at the turn boundary `quiesce` already reached**. The process stays
 * alive, no further turn is started, and no token is spent while the retries run. So the cost of
 * parking is storage retries, not inference — which is the whole reason it is affordable to retry
 * for minutes rather than seconds. A design that retried by re-running the turn would make every
 * storage blip cost real money and would produce a *different* turn each time, so the thing finally
 * persisted would not be the thing that was quiesced.
 *
 * Nothing in this module talks to the agent. That is the point: it retries **one operation**, and if
 * that operation is the snapshot write then by construction nothing else happens between attempts.
 * `suspend()` is what guarantees the agent is quiesced before this is ever called, and
 * `suspend.test.ts` asserts that no turn is sent while a park is in progress.
 *
 * ## Reporting, not silence
 *
 * Every attempt calls {@link ParkOptions.onParked} before it waits. The workflow reports a distinct
 * parked reason so the panel can say "waiting on storage" rather than showing a stalled pause, and
 * the reconciler treats a parked run as live while its heartbeat continues (FR-048). A retry loop
 * that reported nothing would be indistinguishable from a hung pause for as long as the budget runs.
 *
 * ## Failing by name
 *
 * On exhaustion this throws {@link SnapshotBoundaryUnpersistedError}, which carries the **boundary it
 * could not persist**. That is not decoration. "Your work is gone" and "your work is on an instance
 * we are about to destroy, and it was the pause boundary we failed to write" are different messages
 * to receive, and only the second one tells anybody what to do next.
 */

/** Why a snapshot was being taken. Matches the platform's `snapshot_boundary` vocabulary. */
export type SnapshotBoundary = 'completion' | 'pause' | 'interruption' | 'stop'

/** How long parking is allowed to go on for. */
export interface ParkBudget {
  /** Total attempts, the first one included. `3` means one try and two retries. */
  readonly maxAttempts: number
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  /** Multiplier between attempts. */
  readonly factor: number
}

/**
 * The default budget: eight attempts over roughly two minutes.
 *
 * Chosen against what it is actually waiting for. Object storage outages are usually seconds and
 * occasionally a minute; two minutes covers the common case with room, and beyond that the honest
 * answer is that the instance is probably going away and the operator needs to be told which
 * boundary was lost rather than left watching a spinner.
 *
 * It is deliberately *not* unbounded. An unbounded retry on a spot instance under a reclamation
 * notice is a run that never reports anything before the machine disappears.
 */
export const DEFAULT_PARK_BUDGET: ParkBudget = {
  maxAttempts: 8,
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  factor: 2,
}

/** One parked attempt, as reported while the run waits. */
export interface ParkReport {
  /** 1-based. `attempt` failed; `attempt + 1` is about to be tried. */
  readonly attempt: number
  readonly maxAttempts: number
  readonly boundary: SnapshotBoundary
  readonly reason: string
  readonly nextDelayMs: number
}

export interface ParkOptions<TResult> {
  /** The storage write. Retried verbatim; it must be safe to call more than once. */
  readonly operation: () => Promise<TResult>
  readonly boundary: SnapshotBoundary
  readonly budget?: ParkBudget
  /** Called before each wait, so the panel can say "waiting on storage" rather than nothing. */
  readonly onParked?: (report: ParkReport) => void
  /** Injected so a test steps the clock rather than waiting two minutes. */
  readonly sleep?: (milliseconds: number) => Promise<void>
}

/**
 * The failure, naming the boundary (FR-082).
 *
 * A named class rather than a formatted string because the caller has to be able to report the
 * boundary as a field, not scrape it out of a message.
 */
export class SnapshotBoundaryUnpersistedError extends Error {
  readonly boundary: SnapshotBoundary
  readonly attempts: number

  constructor(options: {
    readonly boundary: SnapshotBoundary
    readonly attempts: number
    readonly cause?: unknown
  }) {
    super(
      `durable storage stayed unreachable after ${String(options.attempts)} attempts; ` +
        `the ${options.boundary} snapshot boundary could not be persisted, so the work at that ` +
        'boundary exists only on this instance',
      { cause: options.cause },
    )
    this.name = 'SnapshotBoundaryUnpersistedError'
    this.boundary = options.boundary
    this.attempts = options.attempts
  }
}

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref()
  })

/**
 * The delay before attempt `attempt + 1`, capped.
 *
 * Exported so the backoff shape can be checked without running a park — a schedule that silently
 * flattened to a constant would still pass a test that only checked the final outcome.
 *
 * @param attempt - 1-based number of the attempt that just failed.
 * @param budget - The budget in force.
 */
export const parkDelayMs = (attempt: number, budget: ParkBudget): number =>
  Math.min(budget.initialDelayMs * budget.factor ** (attempt - 1), budget.maxDelayMs)

const describeFailure = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Run `operation`, parking and retrying on failure rather than advancing or dying.
 *
 * @param options - See {@link ParkOptions}.
 * @returns Whatever the operation returned, on the first attempt that succeeds.
 * @throws SnapshotBoundaryUnpersistedError when the budget is exhausted.
 */
export const parkAndRetry = async <TResult>(options: ParkOptions<TResult>): Promise<TResult> => {
  const budget = options.budget ?? DEFAULT_PARK_BUDGET
  const sleep = options.sleep ?? defaultSleep
  let lastError: unknown

  for (let attempt = 1; attempt <= budget.maxAttempts; attempt += 1) {
    try {
      return await options.operation()
    } catch (error) {
      lastError = error

      if (attempt === budget.maxAttempts) {
        break
      }

      const nextDelayMs = parkDelayMs(attempt, budget)

      options.onParked?.({
        attempt,
        maxAttempts: budget.maxAttempts,
        boundary: options.boundary,
        reason: describeFailure(error),
        nextDelayMs,
      })

      await sleep(nextDelayMs)
    }
  }

  throw new SnapshotBoundaryUnpersistedError({
    boundary: options.boundary,
    attempts: budget.maxAttempts,
    cause: lastError,
  })
}
