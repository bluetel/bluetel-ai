/**
 * The wire shape the live-log transport moves, and the sequence reconciliation the panel performs
 * on it.
 *
 * Everything in this module is pure and transport-agnostic on purpose: R6 pre-chose the fallbacks
 * precisely so a failed spike is a change of *fan-out*, not of contract. `LISTEN/NOTIFY`, an
 * in-handler poll of `log_segments` and an always-on stream process all produce the same
 * {@link LogSegmentEvent}, are reconciled by the same {@link createSequenceReconciler}, and are
 * framed for the browser by the same {@link formatSseFrame}. Swapping the transport must not
 * change a byte the panel sees.
 */

/**
 * A single `NOTIFY` channel carrying every workflow, filtered client-side.
 *
 * Per-workflow channel names would mean a `LISTEN` per open panel and no way to parameterise the
 * channel name in a prepared statement; `log_segments` rows are small and the payload is well
 * inside the 8000-byte `NOTIFY` limit.
 */
export const LOG_SEGMENT_CHANNEL = 'sisyphus_log_segment'

/** The SSE `event:` name the panel subscribes to on the `logStream` route. */
export const LOG_SEGMENT_SSE_EVENT = 'log-segment'

export interface LogSegmentEvent {
  readonly workflowId: string
  /** Monotonic per workflow; the only ordering key. Arrival time is never used (R6). */
  readonly sequence: number
  readonly s3Key: string
  readonly byteSize: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export const encodeNotifyPayload = (event: LogSegmentEvent): string => JSON.stringify(event)

/**
 * Returns `null` rather than throwing on a malformed payload.
 *
 * A `NOTIFY` callback runs outside any request; an exception there kills the listener connection
 * and takes the whole stream down for one bad row.
 */
export const decodeNotifyPayload = (payload: string): LogSegmentEvent | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const { workflowId, sequence, s3Key, byteSize } = parsed
  if (typeof workflowId !== 'string' || workflowId.length === 0) return null
  if (typeof sequence !== 'number' || !Number.isFinite(sequence)) return null
  if (typeof s3Key !== 'string') return null
  if (typeof byteSize !== 'number' || !Number.isFinite(byteSize)) return null
  return { workflowId, sequence, s3Key, byteSize }
}

/**
 * The frame the browser receives.
 *
 * `id:` carries the sequence so a reconnecting `EventSource` resumes from its own last sequence via
 * `Last-Event-ID` — the same reconciliation key the transport uses, rather than a second one.
 */
export const formatSseFrame = (event: LogSegmentEvent): string =>
  [
    `id: ${event.sequence}`,
    `event: ${LOG_SEGMENT_SSE_EVENT}`,
    `data: ${JSON.stringify(event)}`,
    '',
    '',
  ].join('\n')

export type SequenceDecision = 'emit' | 'duplicate'

export interface SequenceReconciler {
  /** `duplicate` for anything at or below the high-water mark — replays are free. */
  readonly accept: (event: LogSegmentEvent) => SequenceDecision
  readonly lastSequence: () => number
  /** How many times a segment arrived leaving a hole behind it. */
  readonly gapCount: () => number
  /** Total sequence numbers skipped over. A live-tail transport with no backfill accrues these. */
  readonly missedCount: () => number
}

/**
 * Reconciles by sequence, never by arrival time (R6).
 *
 * `fromSequence` is the client's high-water mark, so a reconnecting panel that re-reads its own
 * tail cannot double-render it — which is what makes an at-least-once transport safe to retry.
 */
export const createSequenceReconciler = (fromSequence = 0): SequenceReconciler => {
  let high = fromSequence
  let gaps = 0
  let missed = 0
  return {
    accept: (event) => {
      if (event.sequence <= high) return 'duplicate'
      if (event.sequence > high + 1) {
        gaps += 1
        missed += event.sequence - high - 1
      }
      high = event.sequence
      return 'emit'
    },
    lastSequence: () => high,
    gapCount: () => gaps,
    missedCount: () => missed,
  }
}
