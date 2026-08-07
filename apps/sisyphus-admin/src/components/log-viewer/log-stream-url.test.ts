import { describe, expect, it } from 'vitest'

import { logStreamUrl, segmentTextUrl } from './log-stream-url'

const WORKFLOW_ID = '01890a5d-ac96-774b-bcce-b302099a8057'

describe('logStreamUrl', () => {
  it('points at the route the SSE handler is mounted on', () => {
    expect(logStreamUrl(WORKFLOW_ID, 0)).toBe(`/api/stream/${WORKFLOW_ID}?fromSequence=0`)
  })

  it('carries the resume point, so the first connection does not replay what is on screen', () => {
    expect(logStreamUrl(WORKFLOW_ID, 41)).toContain('fromSequence=41')
  })

  it('never emits a negative or fractional resume point', () => {
    expect(logStreamUrl(WORKFLOW_ID, -1)).toContain('fromSequence=0')
    expect(logStreamUrl(WORKFLOW_ID, 4.9)).toContain('fromSequence=4')
  })

  it('encodes the id rather than interpolating it into the path raw', () => {
    expect(logStreamUrl('a/b', 0)).toContain('a%2Fb')
  })
})

describe('segmentTextUrl', () => {
  it('addresses one segment under its run', () => {
    expect(segmentTextUrl(WORKFLOW_ID, 7)).toBe(`/api/stream/${WORKFLOW_ID}/segments/7`)
  })

  it('encodes the id here too', () => {
    expect(segmentTextUrl('a/b', 1)).toBe('/api/stream/a%2Fb/segments/1')
  })
})
