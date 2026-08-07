import { describe, expect, it } from 'vitest'

import type { StorageParkResult } from './storage-park'
import { formatRetryDelay, toStorageParkReadout } from './storage-park'

/**
 * The copy that satisfies FR-082's panel clause (T184).
 *
 * The requirement is a sentence — "the panel says it is waiting on storage rather than showing a
 * stalled pause" — so the assertions are about words. That is not incidental: the app already
 * rendered a `parked_resumable` chip and the phrase "waiting on storage" appeared nowhere in it,
 * which is precisely how a run holding at a boundary came to be indistinguishable from one that
 * had hung.
 */

const park = (overrides: Partial<StorageParkResult> = {}): StorageParkResult => ({
  boundary: 'pause',
  attempt: 2,
  maxAttempts: 8,
  nextDelayMs: 2000,
  detail: 'the snapshot bucket is unreachable',
  reportedAt: new Date('2026-08-06T12:00:00Z'),
  waiting: true,
  ...overrides,
})

describe('formatRetryDelay', () => {
  it('reads in whole seconds', () => {
    expect(formatRetryDelay(30_000)).toBe('30s')
  })

  it('never reads as zero — a sub-second wait must not look overdue', () => {
    expect(formatRetryDelay(400)).toBe('1s')
    expect(formatRetryDelay(0)).toBe('1s')
  })
})

describe('toStorageParkReadout', () => {
  it('says nothing for a run that never parked, or for a field that is not there', () => {
    expect(toStorageParkReadout(null)).toBeUndefined()
    expect(toStorageParkReadout(undefined)).toBeUndefined()
  })

  it('says the run is waiting on storage (FR-082)', () => {
    const readout = toStorageParkReadout(park())

    expect(readout?.headline).toBe('Waiting on storage')
    expect(readout?.waiting).toBe(true)
  })

  it('says the write is being retried, and how far through the budget it is', () => {
    const readout = toStorageParkReadout(park({ attempt: 3, maxAttempts: 8, nextDelayMs: 4000 }))

    expect(readout?.explanation).toContain('retried')
    expect(readout?.explanation).toContain('attempt 3 of 8')
    expect(readout?.explanation).toContain('the next in 4s')
  })

  it('rules out the two readings that would get the run killed', () => {
    const readout = toStorageParkReadout(park())

    // "It has stalled" and "it has failed" are the conclusions an operator draws from a run that
    // sits at `running` for two minutes, and both lead to stopping it — which loses the work the
    // park is protecting.
    expect(readout?.explanation).toContain('has not stalled')
    expect(readout?.explanation).toContain('has not failed')
    // And the reason waiting is affordable: parking costs storage retries, not inference.
    expect(readout?.explanation).toContain('no turns and no spend')
  })

  it('names the boundary it is holding at', () => {
    expect(toStorageParkReadout(park({ boundary: 'interruption' }))?.explanation).toContain(
      'interruption boundary',
    )
  })

  it('carries what storage said, separately from the explanation', () => {
    expect(toStorageParkReadout(park())?.cause).toBe('the snapshot bucket is unreachable')
    expect(toStorageParkReadout(park({ detail: null }))?.cause).toBeNull()
    expect(toStorageParkReadout(park({ detail: '' }))?.cause).toBeNull()
  })

  it('turns past tense once the run is no longer waiting, and claims nothing about the ending', () => {
    const readout = toStorageParkReadout(park({ waiting: false, attempt: 1 }))

    expect(readout?.headline).toBe('Waited on storage earlier in this run')
    expect(readout?.explanation).toContain('1 attempt failed')
    // No verdict: the outcome reason is a few lines below in the same card, and two accounts of
    // how a run ended is one too many.
    expect(readout?.explanation).not.toContain('recovered')
    expect(readout?.explanation).not.toContain('succeeded')
  })
})
