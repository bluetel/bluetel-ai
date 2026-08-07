import { describe, expect, it } from 'vitest'

import { resolveResumePoint } from './resume-point'

const request = (options: { readonly lastEventId?: string; readonly query?: string }): Request =>
  new Request(
    `https://sisyphus.example.com/api/stream/w1${options.query === undefined ? '' : `?${options.query}`}`,
    options.lastEventId === undefined
      ? undefined
      : { headers: { 'last-event-id': options.lastEventId } },
  )

describe('resolveResumePoint', () => {
  it('starts at zero for a fresh connection, so the whole log is backfilled', () => {
    expect(resolveResumePoint(request({}))).toBe(0)
  })

  it("reads EventSource's replayed Last-Event-ID, which carries the sequence", () => {
    expect(resolveResumePoint(request({ lastEventId: '41' }))).toBe(41)
  })

  it('reads fromSequence for a caller that is not an EventSource', () => {
    expect(resolveResumePoint(request({ query: 'fromSequence=12' }))).toBe(12)
  })

  it('prefers the header, because after a reconnect the URL is stale by definition', () => {
    expect(resolveResumePoint(request({ lastEventId: '41', query: 'fromSequence=12' }))).toBe(41)
  })

  it('falls through a malformed header to the parameter rather than replaying everything', () => {
    expect(resolveResumePoint(request({ lastEventId: 'nonsense', query: 'fromSequence=12' }))).toBe(
      12,
    )
  })

  it('refuses a negative, fractional or oversized sequence', () => {
    expect(resolveResumePoint(request({ lastEventId: '-5' }))).toBe(0)
    expect(resolveResumePoint(request({ lastEventId: '1.5' }))).toBe(0)
    expect(resolveResumePoint(request({ lastEventId: '99999999999999999999' }))).toBe(0)
  })

  it('treats an empty header as absent', () => {
    expect(resolveResumePoint(request({ lastEventId: '   ' }))).toBe(0)
  })
})
