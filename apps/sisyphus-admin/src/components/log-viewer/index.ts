/**
 * The log viewer (T077, FR-046, SC-002).
 *
 * A run's output, reconciled by `sequence` rather than by arrival time, over the SSE route in
 * `src/app/api/stream`. Duplicates and out-of-order arrival are both designed in rather than
 * exceptional — see `./log-segment-store` for why.
 *
 * `LogViewer` is what a page mounts. Everything else is exported because it is separately testable
 * and separately useful: `LogPane` for a page that has its own source of lines, and the store
 * helpers for anything that needs to reason about a sequence set.
 *
 * Consumers import this barrel, never a module inside it.
 */

export { LogLine } from './log-line'
export type { LogLineState } from './log-line'

export { LogPane } from './log-pane'

export type { LogSegmentRecord } from './log-segment-store'
export { highWaterMark, missingSequences, reconcileSegments, tailWindow } from './log-segment-store'

export { LogSegmentLine } from './log-segment-line'

export type { LogStreamStatus } from './log-stream-events'
export {
  isFinalStatus,
  LOG_SEGMENT_EVENT,
  LOG_STREAM_CLOSED_EVENT,
  nextStatus,
  parseCloseEvent,
  parseSegmentEvent,
} from './log-stream-events'

export { LOG_STREAM_PATH, logStreamUrl, segmentTextUrl } from './log-stream-url'

export { DEFAULT_WINDOW, LogViewer } from './log-viewer'

export type { LogStreamState } from './use-log-stream'
export { LOG_VIEWER_STALE_TIME_MS, useLogStream } from './use-log-stream'
