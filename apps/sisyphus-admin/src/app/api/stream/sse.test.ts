import { describe, expect, it } from 'vitest'

import { formatSseFrame } from './log-segment-event'
import {
  formatSseComment,
  formatSseRetry,
  formatStreamClosed,
  LOG_STREAM_CLOSED_EVENT,
  SSE_HEADERS,
  SSE_KEEPALIVE_MS,
  SSE_RETRY_MS,
} from './sse'

describe('SSE_HEADERS', () => {
  it('declares an event stream that no intermediary may cache or transform', () => {
    expect(SSE_HEADERS['content-type']).toBe('text/event-stream; charset=utf-8')
    expect(SSE_HEADERS['cache-control']).toContain('no-cache')
    expect(SSE_HEADERS['cache-control']).toContain('no-transform')
  })

  it('asks proxies not to buffer, because a buffered SSE stream is not a live log', () => {
    expect(SSE_HEADERS['x-accel-buffering']).toBe('no')
  })
})

describe('frame formatting', () => {
  it('ends every frame with a blank line, which is what dispatches it', () => {
    expect(formatSseComment('warm').endsWith('\n\n')).toBe(true)
    expect(formatSseRetry(SSE_RETRY_MS).endsWith('\n\n')).toBe(true)
    expect(formatStreamClosed('terminal').endsWith('\n\n')).toBe(true)
  })

  it('writes a comment the client ignores', () => {
    expect(formatSseComment('warm')).toBe(': warm\n\n')
  })

  it('states the reconnect delay rather than leaving it to the browser', () => {
    expect(formatSseRetry(SSE_RETRY_MS)).toBe('retry: 3000\n\n')
  })

  it('names the close reason, because "finished" and "gone" mean different things to the viewer', () => {
    expect(formatStreamClosed('terminal')).toContain(`event: ${LOG_STREAM_CLOSED_EVENT}`)
    expect(formatStreamClosed('terminal')).toContain('"reason":"terminal"')
    expect(formatStreamClosed('gone')).toContain('"reason":"gone"')
  })

  it('uses an event name the segment stream cannot be confused with', () => {
    const segment = formatSseFrame({ workflowId: 'w1', sequence: 1, s3Key: 'k', byteSize: 1 })

    expect(segment).not.toContain(LOG_STREAM_CLOSED_EVENT)
  })
})

describe('the timing constants', () => {
  it('waits longer between reconnects than between polls, so a reconnect storm cannot form', () => {
    expect(SSE_RETRY_MS).toBeGreaterThan(250)
  })

  it('keeps an idle connection warm well inside a typical proxy idle timeout', () => {
    expect(SSE_KEEPALIVE_MS).toBeLessThan(60_000)
  })
})
