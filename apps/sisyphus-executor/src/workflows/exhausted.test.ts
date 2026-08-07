import { describe, expect, it } from 'vitest'

import {
  EXHAUSTION_OUTCOME,
  exhaustionReport,
  fourthIterationRefused,
  mustStopForAttention,
} from './exhausted'
import type { IterationHistory } from './iteration-record'

/**
 * An exhausted run stops with its history intact rather than trying a fourth time (FR-062).
 */

const fail = (ordinal: number, ...summaries: readonly string[]): IterationHistory[number] => ({
  ordinal,
  verdict: 'fail',
  findings: summaries.map((summary) => ({ severity: 'blocker' as const, summary })),
})

const threeFailures: IterationHistory = [
  fail(1, 'The retry loop has no ceiling.'),
  fail(2, 'The new timeout is not covered by a test.'),
  fail(3, 'The new timeout is not covered by a test.', 'The error is swallowed.'),
]

describe('mustStopForAttention', () => {
  it('is false while the run still has a pass to give', () => {
    expect(mustStopForAttention([fail(1, 'a'), fail(2, 'b')])).toBe(false)
  })

  it('is false for a run that passed, however many passes it took', () => {
    expect(
      mustStopForAttention([
        fail(1, 'a'),
        fail(2, 'b'),
        { ordinal: 3, verdict: 'pass', findings: [] },
      ]),
    ).toBe(false)
  })

  it('is true once three passes have failed', () => {
    expect(mustStopForAttention(threeFailures)).toBe(true)
  })
})

describe('exhaustionReport', () => {
  it('reaches needs_attention rather than failed', () => {
    expect(exhaustionReport(threeFailures).outcome).toBe(EXHAUSTION_OUTCOME)
    expect(EXHAUSTION_OUTCOME).toBe('needs_attention')
  })

  it('keeps every pass, in order, exactly as recorded', () => {
    const report = exhaustionReport(threeFailures)

    expect(report.history).toHaveLength(3)
    expect(report.history.map((pass) => pass.ordinal)).toEqual([1, 2, 3])
    expect(report.history.map((pass) => pass.verdict)).toEqual(['fail', 'fail', 'fail'])
    expect(report.history[0]?.findings[0]?.summary).toBe('The retry loop has no ceiling.')
    expect(report.history).toEqual(threeFailures)
  })

  it('surfaces the first pass’s blocker even though the later reviews stopped repeating it', () => {
    const summaries = exhaustionReport(threeFailures).unresolved.map((finding) => finding.summary)

    expect(summaries).toContain('The retry loop has no ceiling.')
    expect(summaries).toContain('The new timeout is not covered by a test.')
    expect(summaries).toContain('The error is swallowed.')
    // Deduplicated: iterations two and three raised the same one.
    expect(summaries).toHaveLength(3)
  })

  it('says in words that a fourth iteration was not attempted', () => {
    const report = exhaustionReport(threeFailures)

    expect(report.stoppedWithoutRetrying).toBe(true)
    expect(report.reason).toContain('A fourth iteration was not attempted')
    expect(report.reason).toContain('3 findings remain unresolved')
  })

  it('refuses to end a run that is not actually exhausted', () => {
    expect(() => exhaustionReport([fail(1, 'a')])).toThrow(/not exhausted/iu)
  })
})

describe('fourthIterationRefused', () => {
  it('names the bound and says the history is kept', () => {
    const message = fourthIterationRefused(threeFailures).message

    expect(message).toContain('FR-061')
    expect(message).toContain('bounds an autonomous run at 3')
    expect(message).toContain('history intact')
  })
})
