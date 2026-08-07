/**
 * The bounded, ordered outbox behind the machine-surface client (T062, FR-047).
 *
 * FR-047 requires the executor to buffer and retry reporting when the API is
 * unreachable. Every call routed through here is a *durable record* — a log
 * segment, a bootstrap phase outcome, an artifact, the terminal report — and
 * the machine surface is idempotent on all of them (`appendLogSegment` on
 * `(workflowId, sequence)` by unique index, `reportBootstrapPhase` by update,
 * `reportTerminal` by keeping the first outcome). Idempotency is what makes a
 * blind retry safe: the client cannot tell a lost response from a failed
 * write, and it does not have to.
 *
 * ## The bound, and what happens when it fills
 *
 * The buffer is bounded at {@link DEFAULT_MAX_ENTRIES} calls. **When it is
 * full, the newest call is refused with {@link OutboxFullError} and the outbox
 * latches `isSaturated`. Nothing already accepted is ever discarded.**
 *
 * The obvious alternative — evict the oldest — is wrong here, and not only
 * because it is silent. The oldest entries are the causally earliest ones: the
 * bootstrap phase that failed, the first segments of the run, the output that
 * explains everything after it. Discarding those and keeping the tail produces
 * a record that reads as though the run began mid-sentence, and it does so
 * precisely on the runs that went badly enough to saturate a buffer. Evicting
 * the *newest* silently is no better; it just moves the hole.
 *
 * Refusing loudly is the only option that keeps a caller able to act. Each
 * caller still holds its own data at the moment of refusal — `createSegmentWriter`
 * keeps the segment queued under its already-assigned sequence and retries it
 * on the next write or on the terminal flush, which is the FR-047 path that
 * gets it to durable storage regardless. So a refusal costs a retry, not a
 * record. And because saturation is latched rather than transient, the run can
 * report that its reporting is degraded instead of quietly producing a partial
 * log that looks complete.
 *
 * ## Ordering
 *
 * Delivery is strictly FIFO and strictly sequential — one call in flight at a
 * time. Log segments carry a sequence assigned when the body was cut, and the
 * panel reconciles by sequence; overlapping deliveries would still be correct,
 * but sequential delivery means a persistent failure blocks at the first
 * unsent record rather than punching holes past it.
 */

import type { Backoff, Sleeper } from './backoff'
import { createBackoff, sleep as realSleep } from './backoff'

/** A queued call: its label (for diagnostics) and the thunk that performs it. */
export interface OutboxCall {
  /** Procedure name, used in errors and in the saturation report. */
  readonly procedure: string
  readonly send: () => Promise<void>
}

export interface OutboxOptions {
  /** Hard bound on buffered calls. */
  readonly maxEntries?: number
  readonly backoff?: Backoff
  readonly sleep?: Sleeper
  /**
   * Called the first time the bound is reached, with the call that was
   * refused. The run uses this to mark its reporting degraded rather than to
   * recover: by the time it fires, the buffer is already full.
   */
  readonly onSaturated?: (detail: OutboxSaturation) => void
}

export interface OutboxSaturation {
  readonly procedure: string
  readonly pending: number
  readonly maxEntries: number
}

export interface Outbox {
  /**
   * Accept a call for delivery. Resolves once the call has landed, or rejects
   * with {@link OutboxFullError} if the buffer is full — in which case the call
   * was never accepted and the caller still owns the data.
   *
   * The returned promise settling is the caller's acknowledgement that the
   * record is durable on the surface. A caller that does not want to wait may
   * ignore it; the entry is delivered either way, in order.
   */
  readonly enqueue: (call: OutboxCall) => Promise<void>
  /** Deliver everything held, retrying until it lands. */
  readonly drain: () => Promise<void>
  /** Calls accepted but not yet acknowledged by the surface. */
  readonly pending: number
  /** Latched once the bound has been reached at least once. */
  readonly isSaturated: boolean
}

/**
 * The buffer is full.
 *
 * Carries the procedure that was refused and the bound, because "reporting is
 * behind" and "reporting is behind *by this much*" are different operational
 * facts and only the second one is actionable.
 */
export class OutboxFullError extends Error {
  public readonly procedure: string
  public readonly maxEntries: number

  public constructor(detail: OutboxSaturation) {
    super(
      `The machine-surface outbox is full at ${String(detail.maxEntries)} buffered calls; ` +
        `${detail.procedure} was refused rather than an earlier record being discarded.`,
    )
    this.name = 'OutboxFullError'
    this.procedure = detail.procedure
    this.maxEntries = detail.maxEntries
  }
}

/**
 * 1024 records is roughly a minute of a chatty run at the segment writer's
 * sustained rate, which is longer than any deploy of the panel takes and short
 * enough that a genuinely unreachable surface is noticed rather than absorbed.
 */
export const DEFAULT_MAX_ENTRIES = 1024

interface QueuedCall {
  readonly call: OutboxCall
  readonly resolve: () => void
}

export const createOutbox = (options: OutboxOptions = {}): Outbox => {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const backoff = options.backoff ?? createBackoff()
  const sleep = options.sleep ?? realSleep

  const queue: QueuedCall[] = []
  let saturated = false
  let running: Promise<void> | undefined
  /**
   * Set **before** the delivery loop is started, which `running` cannot be:
   * `run()` executes synchronously up to its first `await`, so the assignment
   * `running = run()` has not happened yet while the first `send` is on the
   * stack. A `send` that enqueues — a summary registered from inside a
   * terminal report, say — would re-enter `pump`, see no `running`, and start
   * a second loop on the same queue, recursively.
   */
  let active = false

  /** Retry the head of the queue until it lands. Never reorders, never skips. */
  const deliverHead = async (entry: QueuedCall): Promise<void> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await entry.call.send()

        return
      } catch {
        // The surface is idempotent on every one of these, so replaying is
        // safe and the only cost of a lost response is a duplicate write that
        // the surface collapses (FR-047).
        await sleep(backoff.delayFor(attempt))
      }
    }
  }

  const run = async (): Promise<void> => {
    while (queue.length > 0) {
      const entry = queue[0]

      await deliverHead(entry)
      queue.shift()
      entry.resolve()
    }
  }

  const pump = (): void => {
    if (active) {
      return
    }

    active = true
    // Deferred by one microtask so `enqueue` never runs a `send` on its own
    // caller's stack. Accepting a call and transmitting it are separate
    // events, and a caller should not be able to observe them as one.
    running = Promise.resolve()
      .then(run)
      .finally(() => {
        active = false
        running = undefined

        // A call accepted between the loop draining and this handler running
        // would otherwise sit in the queue with nothing scheduled to send it.
        if (queue.length > 0) {
          pump()
        }
      })
  }

  return {
    enqueue: async (call: OutboxCall): Promise<void> => {
      if (queue.length >= maxEntries) {
        const detail = { procedure: call.procedure, pending: queue.length, maxEntries }

        if (!saturated) {
          saturated = true
          options.onSaturated?.(detail)
        }

        throw new OutboxFullError(detail)
      }

      const accepted = new Promise<void>((resolve) => {
        queue.push({ call, resolve })
      })

      pump()

      return accepted
    },

    drain: async (): Promise<void> => {
      pump()

      while (running !== undefined) {
        await running
      }
    },

    get pending() {
      return queue.length
    },

    get isSaturated() {
      return saturated
    },
  }
}
