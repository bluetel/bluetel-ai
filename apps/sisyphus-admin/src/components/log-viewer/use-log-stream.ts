'use client'

import { api } from '@sisyphus-admin/trpc'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { LogSegmentRecord } from './log-segment-store'
import { highWaterMark, reconcileSegments } from './log-segment-store'
import type { LogStreamStatus } from './log-stream-events'
import {
  isFinalStatus,
  LOG_SEGMENT_EVENT,
  LOG_STREAM_CLOSED_EVENT,
  nextStatus,
  parseCloseEvent,
  parseSegmentEvent,
} from './log-stream-events'
import { logStreamUrl } from './log-stream-url'

/**
 * Subscribing to one run's output, reconciled by sequence (T077, FR-046, SC-002).
 *
 * ## Two sources, one reconciler
 *
 * The archived read (`workflow.logSegments`) and the SSE stream both feed
 * {@link reconcileSegments}, which is keyed on `sequence`. That is what makes the overlap between
 * them harmless — and the overlap is deliberate, because spike S3's control scenario showed that a
 * reconnect which does *not* re-read loses exactly the downtime window with no error anywhere.
 *
 * ## `staleTime`
 *
 * {@link LOG_VIEWER_STALE_TIME_MS} rather than the console's shared 30-second default. The default
 * is right for configuration reads and wrong beside a live pane: a log that is thirty seconds
 * behind the stream next to it is worse than no log, because it looks current. One second is four
 * poll intervals, so a refetch triggered by a remount can never be more than a transport cycle
 * behind what the stream has already shown. It is set **per query**, which is what
 * `src/trpc/query-client.ts` was built to allow — changing the shared default instead would have
 * pulled every configuration read onto a live cadence.
 *
 * ## What is not covered by tests
 *
 * The subscription itself. There is no testing library in this repository, so this hook is not
 * rendered in a test; what it *decides* is in `./log-segment-store` and `./log-stream-events`,
 * both pure and both directly tested. What remains untested here is the wiring: that the listeners
 * are attached to those event names, and that the source is closed on unmount and on a final
 * status. That is stated rather than implied.
 */

/**
 * Fresh for one second — four poll intervals.
 *
 * Deliberately not zero. A `staleTime` of zero re-reads on every remount, focus and reconnect,
 * and the stream is already the live source; the archived read exists to fill in what happened
 * before this tab was open.
 */
export const LOG_VIEWER_STALE_TIME_MS = 1_000

export interface LogStreamState {
  readonly segments: readonly LogSegmentRecord[]
  readonly status: LogStreamStatus
}

/**
 * Follow a run's output.
 *
 * @param workflowId - The run. A caller who may not see it receives an empty log and an `ended`
 *   status, because the route answers `404` — indistinguishably from a run that does not exist
 *   (FR-190). The viewer must not translate that into "you lack permission".
 * @param enabled - Set false to hold the subscription closed, for a pane that is not on screen.
 */
export const useLogStream = (workflowId: string, enabled = true): LogStreamState => {
  const [live, setLive] = useState<readonly LogSegmentRecord[]>([])
  const [status, setStatus] = useState<LogStreamStatus>('connecting')

  const backfill = api.workflow.logSegments.useQuery(
    { workflowId, fromSequence: 0 },
    { enabled, staleTime: LOG_VIEWER_STALE_TIME_MS },
  )

  const archived = backfill.data

  // **Derived, not copied.** Merging the archived read into state inside an effect would be a
  // second source of truth for something already held twice, and would re-render on every refetch
  // whether or not the answer changed. `reconcileSegments` is order-independent and returns its
  // first argument unchanged when nothing new arrived, so deriving is both correct and cheap.
  //
  // The archived rows are the *current* set and the streamed ones are merged into them, so where
  // the two disagree the database wins — which matches the server's own rule that the first write
  // to a sequence is the one that stands.
  const segments = useMemo(() => reconcileSegments(archived ?? [], live), [archived, live])

  // The resume point is held in a ref rather than read from state inside the subscription effect:
  // depending on `segments` there would tear down and rebuild the `EventSource` on every arriving
  // segment, which is a reconnect storm dressed as a render loop.
  const resumeFrom = useRef(0)

  useEffect(() => {
    resumeFrom.current = Math.max(resumeFrom.current, highWaterMark(segments))
  }, [segments])

  useEffect(() => {
    if (!enabled) return undefined

    const source = new EventSource(logStreamUrl(workflowId, resumeFrom.current))

    const settle = (event: 'open' | 'error' | 'complete' | 'gone') => {
      setStatus((current) => nextStatus(current, event))
      if (isFinalStatus(nextStatus('connecting', event))) {
        // Nothing more will ever arrive, and `EventSource` would otherwise reconnect for ever
        // against a finished run — once per retry interval, per open tab, each attempt costing a
        // scope resolution on the server.
        source.close()
      }
    }

    const onSegment = (event: Event) => {
      const record = parseSegmentEvent((event as MessageEvent<string>).data)
      if (record === undefined) return
      setLive((held) => reconcileSegments(held, [record]))
    }

    const onClosed = (event: Event) => {
      settle(parseCloseEvent((event as MessageEvent<string>).data))
    }

    const onOpen = () => {
      settle('open')
    }

    const onError = () => {
      settle('error')
    }

    source.addEventListener('open', onOpen)
    source.addEventListener('error', onError)
    source.addEventListener(LOG_SEGMENT_EVENT, onSegment)
    source.addEventListener(LOG_STREAM_CLOSED_EVENT, onClosed)

    return () => {
      source.close()
    }
  }, [workflowId, enabled])

  return { segments, status }
}
