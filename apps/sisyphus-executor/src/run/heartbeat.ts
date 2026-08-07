/**
 * **The heartbeat loop (T176, FR-048).**
 *
 * `report/client.ts` has defined `heartbeat` since T062 and nothing outside its own test has ever
 * called it. That is not a missing nicety: the control plane's reconciler parks any run whose last
 * beat is older than `HEARTBEAT_LAPSE_MS`, so an executor that never beats is an executor whose
 * every run gets reaped five minutes in, however well it is working. This module is the caller.
 *
 * ## The interval is a tenth of the lapse, and that ratio is the point
 *
 * Thirty seconds against a five-minute lapse. The margin is not politeness — it is what makes a
 * *single* missed beat mean nothing. A run has to fail to report ten times consecutively before the
 * reconciler acts, which is the difference between "this instance is gone" and "one request to the
 * machine surface timed out", and those must not be the same signal. Raising the interval narrows
 * that margin; lowering it buys nothing, because the reconciler's resolution is the lapse.
 *
 * ## A heartbeat that fails is not an error the run stops for
 *
 * `heartbeat` is one of the two procedures `report/client.ts` deliberately does **not** buffer: a
 * replayed beat from four minutes ago is a false statement about a process that may be dead. So a
 * failure here is counted, reported to `onFailure`, and otherwise dropped — the next beat is along
 * shortly and carries the same information, better. Rejecting out of this loop would take down a
 * run over a network blip, which is the exact mistake the buffering policy exists to avoid.
 *
 * ## What the beat says
 *
 * The state and the consumption, both read through functions rather than captured at construction.
 * A heartbeat that reported the state the run had when the loop started would say `running` for
 * the whole of a pause, and the panel would be telling the user two different things at once.
 */

import type { AgentUsage } from '../agent'
import { formatSpend } from '../caps'
import type { HeartbeatInput, MachineSurfaceClient } from '../report'

/**
 * How often a beat is sent.
 *
 * A tenth of the control plane's `HEARTBEAT_LAPSE_MS`. See the module comment before changing it;
 * the two values are a pair, and only one of them lives in this repository's executor.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000

/** The state a beat carries — the machine surface's vocabulary, not a second one. */
export type HeartbeatState = HeartbeatInput['state']

export interface HeartbeatLoopOptions {
  readonly client: Pick<MachineSurfaceClient, 'heartbeat'>
  /** Read at every beat, so a pause is reported as a pause. */
  readonly state: () => HeartbeatState
  /** Read at every beat, so a lapsed heartbeat and an exhausted cap look different (FR-048). */
  readonly usage: () => AgentUsage
  readonly intervalMs?: number
  /** Injected so a test steps the clock rather than waiting on it. */
  readonly sleep?: (milliseconds: number) => Promise<void>
  /** Called for every failed beat. Reported, never fatal. */
  readonly onFailure?: (error: unknown, consecutiveFailures: number) => void
}

export interface HeartbeatLoop {
  /** One beat. Exposed so a test can step the loop rather than race it. */
  readonly beat: () => Promise<boolean>
  /** Beat until {@link HeartbeatLoop.stop}. Resolves once the loop has actually finished. */
  readonly run: () => Promise<void>
  /** Ask the loop to finish. Resolves when it has. */
  readonly stop: () => Promise<void>
  readonly beats: number
  readonly failures: number
  readonly consecutiveFailures: number
  readonly isRunning: () => boolean
}

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref()
  })

/**
 * Build the heartbeat loop.
 *
 * Construction does not start it — `run()` does, and the entry point holds the promise so shutdown
 * can wait for the loop to leave rather than abandoning it mid-request.
 *
 * @param options - See {@link HeartbeatLoopOptions}.
 */
export const createHeartbeatLoop = (options: HeartbeatLoopOptions): HeartbeatLoop => {
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS
  const sleep = options.sleep ?? defaultSleep

  let beats = 0
  let failures = 0
  let consecutiveFailures = 0
  let running = false
  let stopRequested = false
  let finished: Promise<void> | undefined

  const beat = async (): Promise<boolean> => {
    const consumption = options.usage()

    try {
      await options.client.heartbeat({
        state: options.state(),
        turnsUsed: consumption.turns,
        spendUsed: formatSpend(consumption.spendUsd),
      })
      beats += 1
      consecutiveFailures = 0

      return true
    } catch (error) {
      failures += 1
      consecutiveFailures += 1
      options.onFailure?.(error, consecutiveFailures)

      return false
    }
  }

  /**
   * Read through a function rather than the variable directly — the same reason
   * `supervision/poll.ts` does: `stop()` is called from outside the loop while it is suspended at
   * an `await`, so reading the closed-over variable inline lets the type checker narrow it to the
   * value it had at the top of the iteration and conclude the re-check is dead code.
   */
  const shouldStop = (): boolean => stopRequested

  const run = async (): Promise<void> => {
    running = true
    stopRequested = false

    try {
      // Beat immediately. The first interval is exactly the window in which a bootstrap that took
      // its time looks indistinguishable from an instance that never came up.
      while (!shouldStop()) {
        await beat()

        if (shouldStop()) {
          break
        }

        await sleep(intervalMs)
      }
    } finally {
      running = false
    }
  }

  return {
    beat,
    run: () => (finished ??= run()),
    stop: async () => {
      stopRequested = true

      await finished
    },
    get beats() {
      return beats
    },
    get failures() {
      return failures
    },
    get consecutiveFailures() {
      return consecutiveFailures
    },
    isRunning: () => running,
  }
}
