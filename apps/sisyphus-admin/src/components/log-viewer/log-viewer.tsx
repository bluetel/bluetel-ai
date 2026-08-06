'use client'

import { LogPane } from './log-pane'
import { LogSegmentLine } from './log-segment-line'
import { missingSequences, tailWindow } from './log-segment-store'
import { useLogStream } from './use-log-stream'

/**
 * The log viewer (T077, FR-046, SC-002).
 *
 * Composition only: {@link useLogStream} holds the subscription and the reconciliation,
 * {@link LogPane} is the DESIGN.md `log-viewer` component, and {@link LogSegmentLine} resolves one
 * segment's stored output. Each of those has its own module and its own test; putting them in one
 * file would have produced exactly one thing that could be tested, and it would have been the
 * subscription — the part with no testing library to test it with.
 *
 * ## Reconciled by sequence, never by arrival
 *
 * Stated here because this is the file a reader opens first. Duplicates are expected rather than
 * exceptional — the machine surface is idempotent on `(workflowId, sequence)` so a retried flush
 * replays, and a reconnect deliberately re-reads its own tail, because spike S3 measured a
 * reconnect *without* backfill losing 30 of 150 segments in silence. Out-of-order arrival is
 * equally normal: the archived read and the live stream land in whichever order they finish.
 *
 * ## The window
 *
 * Only the most recent {@link DEFAULT_WINDOW} segments are rendered. Each rendered line resolves
 * its own stored text, so the window bounds the number of in-flight object reads as well as the
 * size of the DOM — an hour-long run is thousands of segments, and a viewer that mounted a fetch
 * for each of them on open would be a self-inflicted load test.
 */

/** How many segments are rendered. The tail, because a live log is read from the bottom. */
export const DEFAULT_WINDOW = 200

interface LogViewerProps {
  readonly workflowId: string
  /** Hold the subscription closed for a pane that is not on screen. */
  readonly enabled?: boolean
  readonly window?: number
}

export const LogViewer = ({
  workflowId,
  enabled = true,
  window = DEFAULT_WINDOW,
}: LogViewerProps) => {
  const { segments, status } = useLogStream(workflowId, enabled)
  const shown = tailWindow(segments, window)

  return (
    <LogPane status={status} total={segments.length} missing={missingSequences(segments)}>
      {shown.map((segment) => (
        <LogSegmentLine key={segment.sequence} segment={segment} />
      ))}
    </LogPane>
  )
}
