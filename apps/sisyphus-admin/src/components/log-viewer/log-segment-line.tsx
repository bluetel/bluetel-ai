'use client'

import { useQuery } from '@tanstack/react-query'

import type { LogLineState } from './log-line'
import { LogLine } from './log-line'
import type { LogSegmentRecord } from './log-segment-store'
import { segmentTextUrl } from './log-stream-url'

/**
 * One segment, with its stored output fetched.
 *
 * ## Why the text is a separate read, and why it is cached for ever
 *
 * `log_segments` records a key, a size and a window; the bytes are in the logs bucket (FR-046). So
 * the stream tells the viewer *that* a segment exists and this fetches *what it said*.
 *
 * `staleTime: Infinity` — the opposite of the list's short freshness, and correct for the same
 * reason the list's is short. A segment is **immutable**: `appendLogSegment` is idempotent on
 * `(workflow_id, sequence)` and the first write wins, so the bytes behind a sequence never change.
 * Re-reading one would be an object fetch that cannot return anything different.
 *
 * `retry: false` because the two failures that matter — the object has aged out of retention, and
 * the segment is too large to display — are both settled answers rather than transient ones, and
 * retrying them would be a per-line loop against S3.
 */

const SEGMENT_TOO_LARGE = 413

interface SegmentText {
  readonly state: LogLineState
  readonly text?: string
}

const readSegment = async (workflowId: string, sequence: number): Promise<SegmentText> => {
  const response = await fetch(segmentTextUrl(workflowId, sequence))

  if (response.status === SEGMENT_TOO_LARGE) {
    return { state: 'too-large' }
  }

  if (!response.ok) {
    // Including `404` for a workflow this caller may not see. The route answers out-of-scope and
    // nonexistent identically (FR-190), and the viewer must not undo that by distinguishing them.
    return { state: 'unavailable' }
  }

  return { state: 'read', text: await response.text() }
}

interface LogSegmentLineProps {
  readonly segment: LogSegmentRecord
}

export const LogSegmentLine = ({ segment }: LogSegmentLineProps) => {
  const content = useQuery({
    queryKey: ['log-segment-text', segment.workflowId, segment.sequence],
    queryFn: () => readSegment(segment.workflowId, segment.sequence),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
  })

  const resolved: SegmentText = content.data ?? {
    state: content.isError ? 'unavailable' : 'loading',
  }

  return <LogLine sequence={segment.sequence} state={resolved.state} text={resolved.text} />
}
