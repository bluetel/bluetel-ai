/**
 * The frame fan-out behind the CLI adapter (T056).
 *
 * Two consumers read the same frames for different reasons and neither may
 * starve the other:
 *
 * - The **adapter itself** watches for the frames that settle a call —
 *   the session acknowledgement `start` waits for, the user echo `sendTurn`
 *   waits for, the `result` that ends the turn `quiesce` waits for.
 * - The **output pipeline** iterates `AgentAdapter.output` to sanitise and
 *   persist everything.
 *
 * Splitting that into its own module keeps the adapter about protocol and this
 * about plumbing. The property worth stating: a frame is delivered to the
 * internal waiters **whether or not anyone is iterating**. If waiting on a turn
 * boundary required a live consumer of `output`, then a caller that stopped
 * reading — because a segment upload was retrying, say — would hang `quiesce`,
 * and pause would fail for a reason with nothing to do with the agent.
 *
 * `waitFor` reports timeouts and stream closure as values rather than throwing.
 * The adapter maps them onto `AgentFailureKind`, and which kind a given wait
 * deserves is the adapter's business: an unacknowledged correction is not a
 * failure in the same sense that a dead process is.
 */

import type { AgentFrame } from './adapter'

export type FramePredicate = (frame: AgentFrame) => boolean

/** Why a wait ended. Exactly one field is set. */
export type FrameWaitOutcome =
  | { readonly kind: 'matched'; readonly frame: AgentFrame; readonly waitedMs: number }
  | { readonly kind: 'timed-out'; readonly waitedMs: number }
  | { readonly kind: 'closed'; readonly waitedMs: number }

export interface FrameStream {
  /** Publish a frame to the iterator and to every internal waiter. */
  readonly emit: (frame: AgentFrame) => void
  /** No more frames will arrive: end the iterator and settle every waiter. */
  readonly close: () => void
  /**
   * Resolve on the first frame matching `predicate`. Only frames emitted
   * **after** this call are considered, so a wait can never be settled by
   * history — which is what lets two identical corrections be told apart.
   */
  readonly waitFor: (predicate: FramePredicate, timeoutMs: number) => Promise<FrameWaitOutcome>
  /**
   * Frames in arrival order, completing when the stream closes.
   *
   * Single-consumer, as the adapter contract says. Frames arriving before
   * anyone iterates are buffered rather than dropped: the agent starts talking
   * immediately and the pipeline that reads it is wired up a moment later.
   */
  readonly iterable: AsyncIterable<AgentFrame>
  readonly isClosed: boolean
}

interface Waiter {
  readonly predicate: FramePredicate
  readonly settle: (outcome: FrameWaitOutcome) => void
}

export interface FrameStreamOptions {
  /** Injected in tests so waiting is measured rather than slept through. */
  readonly now?: () => number
}

export const createFrameStream = (options: FrameStreamOptions = {}): FrameStream => {
  const now = options.now ?? Date.now
  const buffered: AgentFrame[] = []
  const waiters = new Set<Waiter>()
  let pendingRead: ((result: IteratorResult<AgentFrame>) => void) | undefined
  let closed = false

  const deliverToIterator = (frame: AgentFrame): void => {
    if (pendingRead === undefined) {
      buffered.push(frame)

      return
    }

    const read = pendingRead

    pendingRead = undefined
    read({ value: frame, done: false })
  }

  return {
    emit: (frame: AgentFrame): void => {
      if (closed) {
        return
      }

      for (const waiter of [...waiters]) {
        if (waiter.predicate(frame)) {
          waiters.delete(waiter)
          waiter.settle({ kind: 'matched', frame, waitedMs: 0 })
        }
      }

      deliverToIterator(frame)
    },

    close: (): void => {
      if (closed) {
        return
      }

      closed = true

      for (const waiter of [...waiters]) {
        waiters.delete(waiter)
        waiter.settle({ kind: 'closed', waitedMs: 0 })
      }

      if (pendingRead !== undefined) {
        const read = pendingRead

        pendingRead = undefined
        read({ value: undefined, done: true })
      }
    },

    waitFor: (predicate: FramePredicate, timeoutMs: number): Promise<FrameWaitOutcome> =>
      new Promise<FrameWaitOutcome>((resolvePromise) => {
        const startedAt = now()

        if (closed) {
          resolvePromise({ kind: 'closed', waitedMs: 0 })

          return
        }

        const timer = setTimeout(() => {
          waiters.delete(waiter)
          resolvePromise({ kind: 'timed-out', waitedMs: now() - startedAt })
        }, timeoutMs)

        // The process outlives this timer only when the wait is still pending;
        // an executor waiting on a turn boundary must not keep the event loop
        // alive on the strength of a timeout it no longer needs.
        timer.unref()

        const waiter: Waiter = {
          predicate,
          settle: (outcome) => {
            clearTimeout(timer)
            resolvePromise({ ...outcome, waitedMs: now() - startedAt })
          },
        }

        waiters.add(waiter)
      }),

    iterable: {
      [Symbol.asyncIterator]: (): AsyncIterator<AgentFrame> => ({
        next: (): Promise<IteratorResult<AgentFrame>> => {
          const next = buffered.shift()

          if (next !== undefined) {
            return Promise.resolve({ value: next, done: false })
          }

          if (closed) {
            return Promise.resolve({ value: undefined, done: true })
          }

          return new Promise<IteratorResult<AgentFrame>>((resolveRead) => {
            pendingRead = resolveRead
          })
        },
      }),
    },

    get isClosed() {
      return closed
    },
  }
}
