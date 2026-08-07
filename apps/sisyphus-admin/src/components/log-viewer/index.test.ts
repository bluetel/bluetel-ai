import { describe, expect, it } from 'vitest'

import * as logViewer from './index'

describe('the log-viewer barrel', () => {
  it('publishes the component a page mounts and the pieces worth reusing', () => {
    expect(Object.keys(logViewer).sort()).toStrictEqual([
      'DEFAULT_WINDOW',
      'LOG_SEGMENT_EVENT',
      'LOG_STREAM_CLOSED_EVENT',
      'LOG_STREAM_PATH',
      'LOG_VIEWER_STALE_TIME_MS',
      'LogLine',
      'LogPane',
      'LogSegmentLine',
      'LogViewer',
      'highWaterMark',
      'isFinalStatus',
      'logStreamUrl',
      'missingSequences',
      'nextStatus',
      'parseCloseEvent',
      'parseSegmentEvent',
      'reconcileSegments',
      'segmentTextUrl',
      'tailWindow',
      'useLogStream',
    ])
  })

  it('agrees with the route about the event names, which nothing else would catch', () => {
    // The names are strings on both sides of an HTTP boundary; a mismatch is a viewer that
    // connects, stays open and renders nothing — the exact failure spike S3 warned about.
    expect(logViewer.LOG_SEGMENT_EVENT).toBe('log-segment')
    expect(logViewer.LOG_STREAM_CLOSED_EVENT).toBe('log-stream-closed')
    expect(logViewer.LOG_STREAM_PATH).toBe('/api/stream')
  })
})
