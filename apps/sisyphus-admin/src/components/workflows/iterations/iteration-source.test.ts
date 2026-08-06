import { describe, expect, it } from 'vitest'

import type { IterationPass } from './iteration-source'
import { toIterationRecords } from './iteration-source'

/**
 * The row-to-readout boundary.
 *
 * Two things are worth asserting here and nowhere else: that an absent anchor arrives as
 * `undefined` rather than `null` (the card's contract spells absence one way, the column spells it
 * the other), and that the procedure's order survives. Everything about how a record *renders* is
 * settled in `iteration-readouts.test.ts`.
 */

const pass = (
  ordinal: number,
  reviewVerdict: 'pass' | 'fail' | null,
  findings: IterationPass['findings'] = [],
): IterationPass => ({
  iteration: {
    id: `iteration-${String(ordinal)}`,
    workflowId: 'workflow-1',
    ordinal,
    reviewVerdict,
    startedAt: new Date('2026-08-05T09:00:00Z'),
    endedAt: reviewVerdict === null ? null : new Date('2026-08-05T09:30:00Z'),
  },
  findings,
})

describe('toIterationRecords', () => {
  it('flattens each pass, carrying the verdict under the name the card reads', () => {
    const records = toIterationRecords([pass(1, 'fail'), pass(2, 'pass')])

    expect(records.map((record) => record.ordinal)).toStrictEqual([1, 2])
    expect(records.map((record) => record.verdict)).toStrictEqual(['fail', 'pass'])
  })

  it('keeps a null verdict as null rather than treating it as a failure', () => {
    // A pass that has started and not been reviewed has no verdict. Collapsing that to `fail`
    // would show a run as having burned an iteration it is still inside.
    const [record] = toIterationRecords([pass(1, null)])

    expect(record.verdict).toBeNull()
    expect(record.endedAt).toBeNull()
  })

  it('converts an unrecorded anchor from null to undefined', () => {
    const [record] = toIterationRecords([
      pass(1, 'fail', [
        {
          id: 'finding-1',
          iterationId: 'iteration-1',
          severity: 'blocker',
          summary: 'Drops a column that is still read.',
          filePath: null,
          line: null,
          workflowEntryId: null,
          resolvedInIterationId: null,
          createdAt: new Date('2026-08-05T09:15:00Z'),
        },
      ]),
    ])

    expect(record.findings[0]).toStrictEqual({
      severity: 'blocker',
      summary: 'Drops a column that is still read.',
      filePath: undefined,
      line: undefined,
      workflowEntryId: undefined,
    })
  })

  it('carries an anchor through when the finding has one', () => {
    const [record] = toIterationRecords([
      pass(1, 'fail', [
        {
          id: 'finding-1',
          iterationId: 'iteration-1',
          severity: 'major',
          summary: 'Unhandled rejection.',
          filePath: 'src/index.ts',
          line: 42,
          workflowEntryId: 'entry-1',
          resolvedInIterationId: null,
          createdAt: new Date('2026-08-05T09:15:00Z'),
        },
      ]),
    ])

    expect(record.findings[0]).toMatchObject({
      filePath: 'src/index.ts',
      line: 42,
      workflowEntryId: 'entry-1',
    })
  })

  it('does not re-sort what the procedure returned', () => {
    // The procedure orders by ordinal. If this function sorted as well, a procedure that changed
    // its ordering would be silently overridden here instead of being noticed.
    const records = toIterationRecords([pass(2, 'pass'), pass(1, 'fail')])

    expect(records.map((record) => record.ordinal)).toStrictEqual([2, 1])
  })

  it('answers an empty history with an empty list', () => {
    expect(toIterationRecords([])).toStrictEqual([])
  })
})
