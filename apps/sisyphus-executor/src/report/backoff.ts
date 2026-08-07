/**
 * The retry schedule the machine-surface client waits on (T062, FR-047).
 *
 * Pure arithmetic with an injected source of randomness, so a test can assert
 * the exact sequence of delays rather than sleeping through it. Nothing here
 * calls a timer; the waiting belongs to whoever owns the loop.
 *
 * Two properties matter to the platform rather than to this file:
 *
 * - **Jitter is full, not proportional.** Every executor in a fleet loses the
 *   machine surface at the same moment — it is one endpoint — and they all
 *   restart their schedules together. A fixed schedule bunches them
 *   together again on every retry, so the delay is drawn uniformly from
 *   `[0, ceiling]` rather than nudged around it.
 * - **The ceiling is capped but the attempts are not.** The surface being
 *   unreachable is not, by itself, a reason to end a run; it is a reason to
 *   keep the record and keep trying at a rate that costs nothing. Whoever calls
 *   this decides when to give up, and the outbox's bound — not this schedule —
 *   is what makes that decision finite.
 */

export interface BackoffOptions {
  /** Ceiling for the first retry. */
  readonly initialDelayMs?: number
  /** Ceiling the schedule stops growing at. */
  readonly maxDelayMs?: number
  /** Growth per attempt. */
  readonly factor?: number
  /** Injected `[0, 1)` source. Defaults to `Math.random`. */
  readonly random?: () => number
}

export interface Backoff {
  /**
   * Delay before the given attempt, counting from 1 for the first retry.
   * Attempt numbers below 1 are treated as 1 rather than producing a negative
   * exponent, because an off-by-one in a caller should not turn into an
   * instantaneous retry loop.
   */
  readonly delayFor: (attempt: number) => number
}

export const DEFAULT_INITIAL_DELAY_MS = 250
export const DEFAULT_MAX_DELAY_MS = 30_000
export const DEFAULT_BACKOFF_FACTOR = 2

export const createBackoff = (options: BackoffOptions = {}): Backoff => {
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const factor = options.factor ?? DEFAULT_BACKOFF_FACTOR
  const random = options.random ?? Math.random

  return {
    delayFor: (attempt: number): number => {
      const exponent = Math.max(1, Math.floor(attempt)) - 1
      const ceiling = Math.min(maxDelayMs, initialDelayMs * factor ** exponent)

      return Math.round(ceiling * random())
    },
  }
}

/** Wait. The injected default is the only place this file touches a timer. */
export type Sleeper = (milliseconds: number) => Promise<void>

export const sleep: Sleeper = async (milliseconds: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds)
  })
