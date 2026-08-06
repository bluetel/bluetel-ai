import { describe, expect, it } from 'vitest'

import type { LogSegmentRecord } from './log-segment-store'
import { highWaterMark, missingSequences, reconcileSegments, tailWindow } from './log-segment-store'

const record = (sequence: number, s3Key = `logs/w1/${String(sequence)}.log`): LogSegmentRecord => ({
  workflowId: 'w1',
  sequence,
  s3Key,
  byteSize: 512,
})

describe('reconcileSegments', () => {
  it('orders by sequence rather than by arrival', () => {
    const merged = reconcileSegments([], [record(3), record(1), record(2)])

    expect(merged.map((entry) => entry.sequence)).toStrictEqual([1, 2, 3])
  })

  it('drops a duplicate rather than rendering the output twice', () => {
    // The machine surface is idempotent on `(workflowId, sequence)`, so a retried flush replays.
    const first = reconcileSegments([], [record(1), record(2)])
    const merged = reconcileSegments(first, [record(1), record(2), record(3)])

    expect(merged.map((entry) => entry.sequence)).toStrictEqual([1, 2, 3])
  })

  it('keeps the first record for a sequence, as the database does', () => {
    const merged = reconcileSegments(
      [record(1, 'logs/w1/original.log')],
      [record(1, 'logs/w1/rewritten.log')],
    )

    expect(merged[0]?.s3Key).toBe('logs/w1/original.log')
  })

  it('returns the same array when nothing new arrived, so an overlapping poll costs no render', () => {
    const held = reconcileSegments([], [record(1), record(2)])

    expect(reconcileSegments(held, [record(1), record(2)])).toBe(held)
    expect(reconcileSegments(held, [])).toBe(held)
  })

  it('merges a late low sequence into place instead of appending it', () => {
    // Backfill and the live stream land in whichever order they finish.
    const live = reconcileSegments([], [record(4), record(5)])
    const merged = reconcileSegments(live, [record(1), record(2), record(3)])

    expect(merged.map((entry) => entry.sequence)).toStrictEqual([1, 2, 3, 4, 5])
  })

  it('ignores a record whose sequence is not a usable index', () => {
    const merged = reconcileSegments(
      [],
      [record(1), { ...record(2), sequence: -1 }, { ...record(3), sequence: 1.5 }],
    )

    expect(merged.map((entry) => entry.sequence)).toStrictEqual([1])
  })
})

describe('highWaterMark', () => {
  it('is zero for an empty log, so a fresh connection backfills everything', () => {
    expect(highWaterMark([])).toBe(0)
  })

  it('is the highest sequence actually held, which is what a reconnect resumes after', () => {
    expect(highWaterMark(reconcileSegments([], [record(3), record(1)]))).toBe(3)
  })
})

describe('missingSequences', () => {
  it('finds nothing in a continuous log', () => {
    expect(
      missingSequences(reconcileSegments([], [record(1), record(2), record(3)])),
    ).toStrictEqual([])
  })

  it('reports a hole, because a gap is not the same as the agent being quiet (FR-046)', () => {
    expect(missingSequences(reconcileSegments([], [record(1), record(4)]))).toStrictEqual([2, 3])
  })

  it('does not treat a log starting above zero as one long hole', () => {
    // A resumed viewer legitimately begins part-way through.
    expect(missingSequences(reconcileSegments([], [record(90), record(91)]))).toStrictEqual([])
  })

  it('stops counting at the limit rather than walking a long backfill', () => {
    expect(missingSequences(reconcileSegments([], [record(0), record(500)]), 5)).toHaveLength(5)
  })
})

describe('tailWindow', () => {
  it('returns everything when the log is shorter than the window', () => {
    const held = reconcileSegments([], [record(1), record(2)])

    expect(tailWindow(held, 10)).toBe(held)
  })

  it('keeps the newest, because a live log is read from the bottom', () => {
    const held = reconcileSegments([], [record(1), record(2), record(3)])

    expect(tailWindow(held, 2).map((entry) => entry.sequence)).toStrictEqual([2, 3])
  })
})
