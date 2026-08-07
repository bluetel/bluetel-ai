/**
 * A second look at frames that already have a consumer (T194).
 *
 * `AgentAdapter.output` is single-consumer by contract, and the run already has one: `runExecutor`
 * iterates it from the moment the agent is up and turns every frame into a log segment. The
 * developer port needs the same frames for a different reason — it has to see the agent's answer
 * — and a second iterator would not split the stream between them, it would corrupt it: the frame
 * stream holds one pending read, so two readers means frames arriving at whichever of them
 * happened to ask last.
 *
 * So this is a tap rather than a fork. {@link observeAgentFrames} wraps an adapter so that every
 * frame handed to the real consumer is *also* offered to a set of listeners on the way past. The
 * log pipeline stays the single consumer, nothing changes about ordering, and the port sees what
 * the log sees.
 *
 * Two consequences worth stating rather than discovering:
 *
 * - **A tap only sees frames somebody pulls.** If nothing iterates the wrapped `output`, listeners
 *   are never called. That is why the port has a deadline of its own instead of trusting the
 *   stream to keep talking.
 * - **Listeners are not a buffer.** Nothing accumulates here, so a listener registered late has
 *   missed what came before. The port subscribes before it writes its turn for exactly that
 *   reason, in the same order `sendTurn` registers its acknowledgement before writing.
 */

import type { AgentAdapter, AgentFrame } from './adapter'

export interface FrameObserver {
  readonly onFrame?: (frame: AgentFrame) => void
  /** The agent's output ended. No further frames will arrive, ever. */
  readonly onClose?: () => void
}

export interface FrameTap {
  /** Offer one frame to every listener. Called by the wrapper as frames pass through. */
  readonly observe: (frame: AgentFrame) => void
  /** Latch the tap closed and tell every listener. Idempotent. */
  readonly close: () => void
  /**
   * Listen until the returned function is called.
   *
   * Subscribing to an already-closed tap calls `onClose` immediately rather than waiting for a
   * closure that has already happened — a caller that had to check `isClosed` first would have a
   * race between the check and the subscription.
   */
  readonly subscribe: (observer: FrameObserver) => () => void
  readonly isClosed: boolean
}

/**
 * A listener set with no buffer and no ordering of its own.
 *
 * A listener that throws must not stop the frame reaching the others, or the log pipeline, or the
 * agent's own consumer — the tap is an observer of a pipeline it does not own, and it may not be
 * the thing that breaks it. Failures are swallowed here because there is no channel to report them
 * on that would not itself be a way for one listener to disrupt another.
 */
export const createFrameTap = (): FrameTap => {
  const observers = new Set<FrameObserver>()
  let closed = false

  const notify = (call: (observer: FrameObserver) => void): void => {
    for (const observer of [...observers]) {
      try {
        call(observer)
      } catch {
        // See the note above: an observer's failure is its own.
      }
    }
  }

  return {
    observe: (frame: AgentFrame): void => {
      if (closed) {
        return
      }

      notify((observer) => {
        observer.onFrame?.(frame)
      })
    },

    close: (): void => {
      if (closed) {
        return
      }

      closed = true

      notify((observer) => {
        observer.onClose?.()
      })
      observers.clear()
    },

    subscribe: (observer: FrameObserver): (() => void) => {
      if (closed) {
        observer.onClose?.()

        return () => undefined
      }

      observers.add(observer)

      return () => {
        observers.delete(observer)
      }
    },

    get isClosed() {
      return closed
    },
  }
}

/**
 * Wrap an adapter so its frames pass through a tap on the way to their consumer.
 *
 * Everything other than `output` is delegated untouched, and `usage` stays a live read rather than
 * a copy — an adapter whose usage stopped moving would make every cap check answer with the
 * figures from assembly time.
 *
 * @param adapter - The real adapter. Its `output` is still consumed exactly once.
 * @param tap - Where frames are offered as they pass.
 * @returns An adapter to hand to the run in place of the original.
 */
export const observeAgentFrames = (adapter: AgentAdapter, tap: FrameTap): AgentAdapter => ({
  start: (options) => adapter.start(options),
  sendTurn: (body, options) => adapter.sendTurn(body, options),
  quiesce: (options) => adapter.quiesce(options),
  stop: (options) => adapter.stop(options),
  output: {
    [Symbol.asyncIterator]: (): AsyncIterator<AgentFrame> => {
      const inner = adapter.output[Symbol.asyncIterator]()

      return {
        next: async (): Promise<IteratorResult<AgentFrame>> => {
          const result = await inner.next()

          if (result.done === true) {
            tap.close()

            return result
          }

          tap.observe(result.value)

          return result
        },
      }
    },
  },
  get usage() {
    return adapter.usage
  },
})
