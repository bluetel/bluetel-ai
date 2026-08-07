import type { LogSegmentRecord } from './log-segment-store'

/**
 * Decoding what arrives on the wire, and deciding what the viewer says about the connection.
 *
 * Pure and separate from the hook on purpose: an `EventSource` is awkward to drive in a test, and
 * these are the two parts that carry meaning. Everything the hook does beyond this is subscribe,
 * unsubscribe and `setState`.
 */

/** The `event:` names the route emits. Must match `src/app/api/stream/sse.ts`. */
export const LOG_SEGMENT_EVENT = 'log-segment'
export const LOG_STREAM_CLOSED_EVENT = 'log-stream-closed'

/**
 * What the viewer tells the reader about the connection.
 *
 * `complete` and `gone` are both "this stream will not resume", and they are separate because they
 * mean opposite things: `complete` is the run having finished and the log being whole, `gone` is
 * the run no longer being visible to this reader — which after a revoked grant is the honest
 * answer and must not be dressed up as completion.
 */
export type LogStreamStatus = 'connecting' | 'live' | 'interrupted' | 'complete' | 'gone'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/**
 * Read a `log-segment` frame's payload.
 *
 * Returns `undefined` rather than throwing on anything malformed. A frame is decoded inside an
 * event listener, where an exception is unhandled and takes down nothing useful — one bad frame
 * must not end a stream that will keep delivering good ones.
 */
export const parseSegmentEvent = (data: string): LogSegmentRecord | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return undefined
  }

  if (!isRecord(parsed)) return undefined
  const { workflowId, sequence, s3Key, byteSize } = parsed
  if (typeof workflowId !== 'string' || workflowId === '') return undefined
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0)
    return undefined
  if (typeof s3Key !== 'string') return undefined
  if (typeof byteSize !== 'number' || !Number.isFinite(byteSize)) return undefined

  return { workflowId, sequence, s3Key, byteSize }
}

/**
 * Read a `log-stream-closed` frame.
 *
 * An unrecognised reason is treated as `gone` rather than as `complete`: claiming a log is whole
 * when the server said something this build does not understand is the failure that looks like
 * success.
 */
export const parseCloseEvent = (data: string): 'complete' | 'gone' => {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return 'gone'
  }

  return isRecord(parsed) && parsed.reason === 'terminal' ? 'complete' : 'gone'
}

/**
 * Whether a status is one the browser should stop reconnecting from.
 *
 * `EventSource` reconnects for ever by default; a finished run would otherwise be re-queried every
 * few seconds by every tab left open on it, each attempt costing a scope resolution.
 */
export const isFinalStatus = (status: LogStreamStatus): boolean =>
  status === 'complete' || status === 'gone'

/**
 * Apply a connection event to the current status.
 *
 * The one rule worth stating: a transport `error` **cannot** move a final status. `EventSource`
 * fires `error` when it closes the connection, including the close that follows the server's own
 * close frame — so without this a completed log would flip to `interrupted` a moment after saying
 * it was whole.
 */
export const nextStatus = (
  current: LogStreamStatus,
  event: 'open' | 'error' | 'complete' | 'gone',
): LogStreamStatus => {
  if (event === 'complete' || event === 'gone') {
    return event
  }

  if (isFinalStatus(current)) {
    return current
  }

  return event === 'open' ? 'live' : 'interrupted'
}
