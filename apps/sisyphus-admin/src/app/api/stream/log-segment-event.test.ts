import { describe, expect, it } from 'vitest'

import type { LogSegmentEvent } from './log-segment-event'
import {
  createSequenceReconciler,
  decodeNotifyPayload,
  encodeNotifyPayload,
  formatSseFrame,
  LOG_SEGMENT_CHANNEL,
  LOG_SEGMENT_SSE_EVENT,
} from './log-segment-event'

const segment = (sequence: number): LogSegmentEvent => ({
  workflowId: '11111111-1111-4111-8111-111111111111',
  sequence,
  s3Key: `spike/${sequence}.log`,
  byteSize: 128,
})

describe('notify payload codec', () => {
  it('round-trips a segment', () => {
    const event = segment(7)
    expect(decodeNotifyPayload(encodeNotifyPayload(event))).toEqual(event)
  })

  it('returns null rather than throwing on malformed JSON', () => {
    expect(decodeNotifyPayload('{not json')).toBeNull()
  })

  it.each([
    ['missing workflowId', '{"sequence":1,"s3Key":"a","byteSize":1}'],
    ['empty workflowId', '{"workflowId":"","sequence":1,"s3Key":"a","byteSize":1}'],
    ['sequence as string', '{"workflowId":"w","sequence":"1","s3Key":"a","byteSize":1}'],
    ['non-finite byteSize', '{"workflowId":"w","sequence":1,"s3Key":"a","byteSize":null}'],
    ['not an object', '"just a string"'],
  ])('returns null for %s', (_label, payload) => {
    expect(decodeNotifyPayload(payload)).toBeNull()
  })

  it('names one channel for every workflow', () => {
    expect(LOG_SEGMENT_CHANNEL).toBe('sisyphus_log_segment')
  })
})

describe('formatSseFrame', () => {
  it('carries the sequence as the SSE id so Last-Event-ID resumes by sequence', () => {
    const frame = formatSseFrame(segment(42))
    expect(frame).toContain('id: 42')
    expect(frame).toContain(`event: ${LOG_SEGMENT_SSE_EVENT}`)
    expect(frame.endsWith('\n\n')).toBe(true)
  })

  it('emits data as a single line so no segment can split a frame', () => {
    const frame = formatSseFrame({ ...segment(1), s3Key: 'has\nnewline' })
    const dataLines = frame.split('\n').filter((line) => line.startsWith('data: '))
    expect(dataLines).toHaveLength(1)
  })
})

describe('createSequenceReconciler', () => {
  it('emits an in-order run exactly once', () => {
    const reconciler = createSequenceReconciler(0)
    const decisions = [1, 2, 3, 4].map((n) => reconciler.accept(segment(n)))
    expect(decisions).toEqual(['emit', 'emit', 'emit', 'emit'])
    expect(reconciler.lastSequence()).toBe(4)
    expect(reconciler.gapCount()).toBe(0)
  })

  it('suppresses a replayed tail after a reconnect', () => {
    const reconciler = createSequenceReconciler(10)
    expect(reconciler.accept(segment(8))).toBe('duplicate')
    expect(reconciler.accept(segment(10))).toBe('duplicate')
    expect(reconciler.accept(segment(11))).toBe('emit')
  })

  it('counts a hole rather than silently closing over it', () => {
    const reconciler = createSequenceReconciler(0)
    reconciler.accept(segment(1))
    reconciler.accept(segment(5))
    expect(reconciler.gapCount()).toBe(1)
    expect(reconciler.missedCount()).toBe(3)
    expect(reconciler.lastSequence()).toBe(5)
  })

  it('starts from the client high-water mark so a resumed stream emits nothing twice', () => {
    const reconciler = createSequenceReconciler(100)
    expect(reconciler.lastSequence()).toBe(100)
    expect(reconciler.accept(segment(100))).toBe('duplicate')
    expect(reconciler.gapCount()).toBe(0)
  })
})
