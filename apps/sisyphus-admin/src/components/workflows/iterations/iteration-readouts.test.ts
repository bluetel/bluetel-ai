import { describe, expect, it } from 'vitest'

import type { IterationRecord } from './iteration-readouts'
import {
  MAX_ITERATIONS,
  toIterationTimelineReadouts,
  unresolvedFindings,
} from './iteration-readouts'

/**
 * Shaping an autonomous run's iterations (FR-061, FR-062, FR-119).
 */

const iteration = (
  ordinal: number,
  verdict: IterationRecord['verdict'],
  ...summaries: readonly string[]
): IterationRecord => ({
  id: `it-${String(ordinal)}`,
  ordinal,
  verdict,
  startedAt: null,
  endedAt: null,
  findings: summaries.map((summary) => ({ severity: 'blocker' as const, summary })),
})

const threeFailures: readonly IterationRecord[] = [
  iteration(1, 'fail', 'The retry loop has no ceiling.'),
  iteration(2, 'fail', 'The new timeout is not covered by a test.'),
  iteration(3, 'fail', 'The new timeout is not covered by a test.', 'The error is swallowed.'),
]

describe('toIterationTimelineReadouts', () => {
  it('shows the bound in every ordinal rather than in a legend', () => {
    const timeline = toIterationTimelineReadouts([iteration(1, 'fail', 'a')])

    expect(MAX_ITERATIONS).toBe(3)
    expect(timeline.iterations[0]?.ordinal).toBe('1 of 3')
    expect(timeline.readout).toBe('1 of 3')
  })

  it('tells three failures apart from three passes-then-success', () => {
    const failed = toIterationTimelineReadouts(threeFailures)
    const passed = toIterationTimelineReadouts([
      iteration(1, 'fail', 'a'),
      iteration(2, 'fail', 'b'),
      iteration(3, 'pass'),
    ])

    expect(failed.exhausted).toBe(true)
    expect(failed.statement).toContain('none passed review')
    expect(passed.exhausted).toBe(false)
    expect(passed.statement).toBe('Review passed on iteration 3 of 3.')
  })

  it('says a run still in flight has not finished', () => {
    const timeline = toIterationTimelineReadouts([iteration(1, 'fail', 'a')])

    expect(timeline.exhausted).toBe(false)
    expect(timeline.statement).toContain('has not finished')
  })

  it('reads a pass with no verdict yet as in flight rather than as a failure', () => {
    const timeline = toIterationTimelineReadouts([iteration(1, null)])

    expect(timeline.iterations[0]?.verdict).toBe('in flight')
  })

  it('says plainly when nothing has been recorded', () => {
    const timeline = toIterationTimelineReadouts([])

    expect(timeline.statement).toContain('no development iterations')
    expect(timeline.unresolved).toEqual([])
  })

  it('keeps the order it was given — a timeline the panel re-sorted is not the record', () => {
    const timeline = toIterationTimelineReadouts(threeFailures)

    expect(timeline.iterations.map((entry) => entry.ordinal)).toEqual([
      '1 of 3',
      '2 of 3',
      '3 of 3',
    ])
  })

  it('anchors a finding to entry, file and line (FR-119)', () => {
    const timeline = toIterationTimelineReadouts([
      {
        id: 'it-1',
        ordinal: 1,
        verdict: 'fail',
        startedAt: null,
        endedAt: null,
        findings: [
          {
            workflowEntryId: 'entry-client',
            filePath: 'src/checkout.ts',
            line: 88,
            severity: 'blocker',
            summary: 'Field never sent.',
          },
        ],
      },
    ])

    expect(timeline.iterations[0]?.findings[0]?.location).toBe('entry-client · src/checkout.ts:88')
  })

  it('leaves the location empty for a finding about the change as a whole', () => {
    const timeline = toIterationTimelineReadouts([
      iteration(1, 'fail', 'These must land together.'),
    ])

    expect(timeline.iterations[0]?.findings[0]?.location).toBe('')
  })
})

describe('unresolvedFindings (FR-062)', () => {
  it('keeps a blocker from the first pass the later reviews stopped repeating', () => {
    expect(unresolvedFindings(threeFailures).map((finding) => finding.summary)).toEqual([
      'The retry loop has no ceiling.',
      'The new timeout is not covered by a test.',
      'The error is swallowed.',
    ])
  })

  it('clears everything a later passing review superseded', () => {
    expect(unresolvedFindings([iteration(1, 'fail', 'a'), iteration(2, 'pass')])).toEqual([])
  })

  it('has nothing to surface for a run that passed first time', () => {
    expect(unresolvedFindings([iteration(1, 'pass')])).toEqual([])
  })
})
