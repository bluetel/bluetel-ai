import { describe, expect, it } from 'vitest'

import type { IterationHistory, IterationRecord } from './iteration-record'
import {
  hasPassed,
  isExhausted,
  MAX_ITERATIONS,
  nextOrdinal,
  recordIteration,
  unresolvedFindings,
} from './iteration-record'

/**
 * The iteration ledger — where the loop stops asking, and what it keeps (FR-061, FR-062).
 */

const pass = (ordinal: number): IterationRecord => ({ ordinal, verdict: 'pass', findings: [] })

const fail = (ordinal: number, ...summaries: readonly string[]): IterationRecord => ({
  ordinal,
  verdict: 'fail',
  findings: summaries.map((summary) => ({ severity: 'blocker' as const, summary })),
})

const collect = (): {
  readonly report: (record: IterationRecord) => Promise<void>
  readonly reported: readonly IterationRecord[]
} => {
  const reported: IterationRecord[] = []

  return {
    reported,
    report: async (record) => {
      reported.push(record)
      return Promise.resolve()
    },
  }
}

describe('the bound', () => {
  it('is three, per FR-061', () => {
    expect(MAX_ITERATIONS).toBe(3)
  })

  it('offers no fourth ordinal at all rather than one a caller might use', () => {
    expect(nextOrdinal([])).toBe(1)
    expect(nextOrdinal([fail(1, 'a')])).toBe(2)
    expect(nextOrdinal([fail(1, 'a'), fail(2, 'b')])).toBe(3)
    expect(nextOrdinal([fail(1, 'a'), fail(2, 'b'), fail(3, 'c')])).toBeUndefined()
  })

  it('reports exhaustion at three, not at four', () => {
    expect(isExhausted([fail(1, 'a'), fail(2, 'b')])).toBe(false)
    expect(isExhausted([fail(1, 'a'), fail(2, 'b'), fail(3, 'c')])).toBe(true)
  })
})

describe('recordIteration', () => {
  it('reports the pass and adds it to the history', async () => {
    const sink = collect()

    const history = await recordIteration(
      [],
      fail(1, 'The retry loop has no ceiling.'),
      sink.report,
    )

    expect(sink.reported).toHaveLength(1)
    expect(history).toHaveLength(1)
    expect(history[0]?.findings[0]?.summary).toBe('The retry loop has no ceiling.')
  })

  it('refuses a fourth pass before the platform is troubled with it', async () => {
    const sink = collect()

    await expect(recordIteration([], { ...fail(4, 'too late') }, sink.report)).rejects.toThrow(
      /bounded at 3 development iterations/iu,
    )
    expect(sink.reported).toEqual([])
  })

  it('never mutates the history it was given', async () => {
    const sink = collect()
    const original: IterationHistory = [fail(1, 'first')]

    await recordIteration(original, fail(2, 'second'), sink.report)

    expect(original).toHaveLength(1)
  })
})

describe('unresolvedFindings (FR-062)', () => {
  it('keeps a blocker from the first pass that the later reviews stopped repeating', () => {
    const history: IterationHistory = [
      fail(1, 'The retry loop has no ceiling.'),
      fail(2, 'The new timeout is not covered by a test.'),
      fail(3, 'The new timeout is not covered by a test.'),
    ]

    expect(unresolvedFindings(history).map((finding) => finding.summary)).toEqual([
      'The retry loop has no ceiling.',
      'The new timeout is not covered by a test.',
    ])
  })

  it('clears everything a later passing review superseded', () => {
    const history: IterationHistory = [fail(1, 'The retry loop has no ceiling.'), pass(2)]

    expect(unresolvedFindings(history)).toEqual([])
    expect(hasPassed(history)).toBe(true)
  })

  it('distinguishes the same summary anchored to different repositories (FR-119)', () => {
    const history: IterationHistory = [
      {
        ordinal: 1,
        verdict: 'fail',
        findings: [
          { workflowEntryId: 'entry-a', severity: 'blocker', summary: 'Unbounded retry.' },
          { workflowEntryId: 'entry-b', severity: 'blocker', summary: 'Unbounded retry.' },
        ],
      },
    ]

    expect(unresolvedFindings(history)).toHaveLength(2)
  })

  it('has nothing to surface for a run that passed first time', () => {
    expect(unresolvedFindings([pass(1)])).toEqual([])
  })
})
