import { TERMINAL_WORKFLOW_STATES } from '@bluetel-ai/sisyphus-api/client'

import type { LogSegmentEvent } from './log-segment-event'
import { createSequenceReconciler } from './log-segment-event'
import type { StreamCloseReason } from './sse'

/**
 * The live-log transport: an in-handler short poll of `log_segments` by `(workflow_id, sequence)`.
 *
 * This is R6's first fallback, adopted because spike S3 closed the question against
 * `LISTEN/NOTIFY`. The measurement is in `./SPIKE-FINDINGS.md`; the two findings that shape this
 * module are worth restating where the code is:
 *
 * 1. **`LISTEN/NOTIFY` through a transaction-mode pooler delivers nothing, and says nothing.**
 *    0 of 300 notifications arrived, `transportErrors` was 0, and the `LISTEN` registration leaked
 *    into the pool for later requests to inherit. Polling is slower and it is *observable*.
 * 2. **A reconnect must be a `sequence > lastRendered` read.** The control scenario — reconnect
 *    with no backfill — lost 30 of 150 segments over a 3-second gap. So the first thing this
 *    generator does, before any wait, is read from the caller's high-water mark. Backfill is not
 *    an optimisation and not conditional.
 *
 * Latency is entirely the poll interval: p50 ≈ interval/2, p95 ≈ interval. At 250 ms that is a p95
 * of 238 ms against SC-002's 5-second budget, four doublings of headroom.
 *
 * ## The cost this transport has, stated
 *
 * Fan-out. N open panels are N × (1/interval) queries per second, and the spike measured one
 * consumer. That is why the workflow-state read is on its own slower cadence rather than doubling
 * the query rate, and why the stream closes itself the moment the run is finished instead of
 * waiting for the browser to lose interest.
 *
 * ## Purity
 *
 * Everything is injected — both reads, the clock and the sleep — so the loop's decisions
 * (backfill, reconciliation, terminal drain, keep-alive, abort) are testable without a database
 * and without real time. The only thing that touches Postgres is the route that supplies the
 * readers.
 */

/** The interval spike S3 measured at p95 238 ms. */
export const LOG_POLL_INTERVAL_MS = 250

/**
 * How often the run's state is re-read.
 *
 * Slower than the segment poll on purpose. Reading state every pass would double this transport's
 * query rate for a fact that changes once per run, and one second is far inside SC-002 — a stream
 * that stays open an extra second after the last segment costs nothing, whereas twice the queries
 * across every open panel is the cost the polling fallback is actually exposed to.
 */
export const DEFAULT_STATE_INTERVAL_MS = 1_000

/** How many segments one pass will carry, so a long backfill arrives in bounded chunks. */
export const DEFAULT_SEGMENT_BATCH = 500

const TERMINAL_STATES: ReadonlySet<string> = new Set<string>(TERMINAL_WORKFLOW_STATES)

/**
 * True when no further output will ever be produced without a human.
 *
 * `parked_resumable` counts. It is re-enterable, but re-entering it creates a *successor*
 * workflow with its own id and its own segment sequence — so this stream is finished either way,
 * and holding the connection open would be waiting for output that will be written elsewhere.
 */
export const isTerminalWorkflowState = (state: string): boolean => TERMINAL_STATES.has(state)

/** What the generator emits. The route turns each of these into a frame. */
export type LogStreamMessage =
  | { readonly kind: 'segment'; readonly event: LogSegmentEvent }
  | { readonly kind: 'keepalive' }
  | { readonly kind: 'closed'; readonly reason: StreamCloseReason }

export interface LogSegmentPollOptions {
  /** Segments strictly after `afterSequence`, ascending, at most `limit` of them. */
  readonly readSegmentsAfter: (
    afterSequence: number,
    limit: number,
  ) => Promise<readonly LogSegmentEvent[]>
  /**
   * The run's state **as this caller may currently see it**.
   *
   * `undefined` means gone: either deleted, or no longer visible because a grant was revoked while
   * the stream was open (FR-184). The two are the same answer here for the same reason they are
   * the same answer at connect (FR-190).
   */
  readonly readWorkflowState: () => Promise<string | undefined>
  /** The client's high-water mark. Segments **strictly after** it are sent. */
  readonly fromSequence?: number
  readonly intervalMs?: number
  readonly stateIntervalMs?: number
  readonly keepaliveMs?: number
  readonly batchSize?: number
  readonly signal?: AbortSignal
  /** Injected so tests do not wait. Resolves early when the signal aborts. */
  readonly wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  readonly now?: () => number
}

/**
 * Sleep that gives up when the reader goes away.
 *
 * A poll loop that outlives its reader is a paid query every 250 ms that nobody will ever see, so
 * the abort has to interrupt the *wait* rather than only be noticed after it.
 */
const sleep = (milliseconds: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)

    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })

/**
 * Follow one workflow's output until it ends, the caller loses sight of it, or the reader leaves.
 *
 * @param options - The two reads and the timing knobs.
 * @yields Segments in sequence order, a keep-alive while idle, and exactly one close message when
 *   the stream ends of its own accord. An aborted stream ends **without** a close message — the
 *   reader is already gone, and there is nobody to tell.
 */
export const pollLogSegments = async function* (
  options: LogSegmentPollOptions,
): AsyncGenerator<LogStreamMessage> {
  const intervalMs = options.intervalMs ?? LOG_POLL_INTERVAL_MS
  const stateIntervalMs = options.stateIntervalMs ?? DEFAULT_STATE_INTERVAL_MS
  const keepaliveMs = options.keepaliveMs ?? 15_000
  const batchSize = options.batchSize ?? DEFAULT_SEGMENT_BATCH
  const wait = options.wait ?? sleep
  const now = options.now ?? Date.now
  const { signal } = options

  const reconciler = createSequenceReconciler(options.fromSequence ?? 0)

  let lastFrameAt = now()
  let lastStateAt = Number.NEGATIVE_INFINITY
  let pendingClose: StreamCloseReason | undefined

  const aborted = () => signal?.aborted === true

  while (!aborted()) {
    // The backfill. First thing, every time, before any wait — spike S3 finding (g).
    const segments = await options.readSegmentsAfter(reconciler.lastSequence(), batchSize)

    let emitted = 0
    for (const event of segments) {
      // Duplicates are expected rather than exceptional: `appendLogSegment` is idempotent on
      // `(workflow_id, sequence)`, so a retried flush and a resumed stream both replay a tail.
      // Anything at or below the high-water mark is dropped here.
      if (reconciler.accept(event) === 'emit') {
        yield { kind: 'segment', event }
        emitted += 1
      }
    }

    if (emitted > 0) {
      lastFrameAt = now()
      // Output arrived after the run looked finished — a buffered flush landing behind
      // `reportTerminal` (FR-047). Keep going; the next quiet pass will observe terminal again.
      pendingClose = undefined
    } else if (pendingClose !== undefined) {
      // The drain pass found nothing more. Now it is safe to say the log is complete.
      yield { kind: 'closed', reason: pendingClose }
      return
    }

    if (aborted()) {
      return
    }

    if (now() - lastStateAt >= stateIntervalMs) {
      lastStateAt = now()
      const state = await options.readWorkflowState()

      if (state === undefined) {
        // Closed **immediately**, with no drain pass. The segment read is keyed on the workflow
        // alone; only this read is scoped. A caller who has just lost sight of the run must not be
        // handed one more batch of its output on the way out.
        yield { kind: 'closed', reason: 'gone' }
        return
      }

      if (isTerminalWorkflowState(state)) {
        // Not closed yet: one more segment read has to come back empty first, because
        // `reportTerminal` can land before the executor's last buffered segment does.
        pendingClose = 'terminal'
      } else {
        pendingClose = undefined
      }
    }

    if (aborted()) {
      return
    }

    if (now() - lastFrameAt >= keepaliveMs) {
      yield { kind: 'keepalive' }
      lastFrameAt = now()
    }

    // The wait is what the abort interrupts; without it an aborted stream would keep querying
    // until the next tick noticed.
    await wait(intervalMs, signal)
  }
}
