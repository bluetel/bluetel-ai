import { describe, expect, it } from 'vitest'

import type { SpendGroup, SpendSummary } from './spend-readouts'
import { toSpendGroupReadouts, toSpendReadouts, UNATTRIBUTED } from './spend-readouts'

/**
 * What the spend card claims, checked as a table of inputs and outputs.
 *
 * Two properties are worth more than the rest. **Money is never reformatted** — the procedure hands
 * over a `numeric(12,4)` as a decimal string precisely so it is not rounded, and a readout that
 * rounded it would silently lose the fourth place on every figure the panel shows. And the
 * **share's denominator is the scoped total**, so a group's bar is its share of what the caller may
 * see; anything else would need a figure that includes runs they may not (FR-190).
 */

const group = (over: Partial<SpendGroup> = {}): SpendGroup => ({
  groupId: '0199a1f4-0000-7000-8000-0000000000ab',
  groupLabel: 'API maintenance',
  workflowCount: 3,
  spendTotal: '75.0000',
  turnsTotal: 42,
  ...over,
})

const summary = (over: Partial<SpendSummary> = {}): SpendSummary => ({
  groups: [group()],
  workflowCount: 3,
  spendTotal: '100.0000',
  turnsTotal: 42,
  ...over,
})

describe('one group', () => {
  it('passes the decimal string through untouched', () => {
    const readouts = toSpendGroupReadouts(group({ spendTotal: '3.1416' }), '10.0000')

    // Not `3.14`, not `£3.14`: the fourth place is the reason the column is `numeric(12,4)`.
    expect(readouts.spend).toBe('3.1416')
  })

  it('reports the share of the scoped total', () => {
    expect(toSpendGroupReadouts(group(), '100.0000').share).toBeCloseTo(75, 6)
  })

  it('reads a zero total as a zero share rather than as NaN', () => {
    const readouts = toSpendGroupReadouts(group({ spendTotal: '0.0000' }), '0.0000')

    expect(readouts.share).toBe(0)
    expect(Number.isNaN(readouts.share)).toBe(false)
  })

  it('states that a run with no client or profile is unattributed, not blank', () => {
    // An ad hoc run has no profile and a manually started one has no client. Both are facts about
    // how the run began (FR-126), so the row says so rather than showing an empty cell.
    const readouts = toSpendGroupReadouts(group({ groupId: null, groupLabel: null }), '100.0000')

    expect(readouts.name).toBe(UNATTRIBUTED)
    expect(readouts.key).toBe(UNATTRIBUTED)
  })
})

describe('the whole summary', () => {
  it('carries the scoped totals as the procedure returned them', () => {
    const readouts = toSpendReadouts(summary())

    expect(readouts.spend).toBe('100.0000')
    expect(readouts.workflows).toBe('3')
    expect(readouts.turns).toBe('42')
  })

  it('keeps the procedure’s order rather than re-sorting', () => {
    const readouts = toSpendReadouts(
      summary({
        groups: [
          group({ groupId: 'a', groupLabel: 'Alpha', spendTotal: '60.0000' }),
          group({ groupId: 'b', groupLabel: 'Beta', spendTotal: '40.0000' }),
        ],
      }),
    )

    expect(readouts.groups.map((row) => row.name)).toStrictEqual(['Alpha', 'Beta'])
  })

  it('renders an empty scope as no groups and no invented total', () => {
    const readouts = toSpendReadouts(
      summary({ groups: [], workflowCount: 0, spendTotal: '0.0000', turnsTotal: 0 }),
    )

    expect(readouts.groups).toStrictEqual([])
    expect(readouts.spend).toBe('0.0000')
  })
})
