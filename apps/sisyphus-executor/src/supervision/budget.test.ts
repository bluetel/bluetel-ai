import { describe, expect, it } from 'vitest'

import {
  ACKNOWLEDGE_BUDGET_MS,
  PAUSE_LATENCY_CEILING_MS,
  pauseLatencyBudget,
  POLL_INTERVAL_MS,
  PULL_ROUND_TRIP_MS,
  QUIESCE_BUDGET_MS,
  SNAPSHOT_BUDGET_MS,
} from './budget'

/**
 * SC-003 is a number, so it is worth asserting as one.
 *
 * These tests fail if somebody widens a term without widening the ceiling — which is the edit that
 * quietly makes the pause path miss its deadline while every other test still passes.
 */

describe('the SC-003 pause budget', () => {
  it('fits inside the ten seconds, with slack held back rather than spent', () => {
    const budget = pauseLatencyBudget()

    expect(budget.ceilingMs).toBe(PAUSE_LATENCY_CEILING_MS)
    expect(budget.totalMs).toBe(9_000)
    expect(budget.slackMs).toBe(1_000)
    expect(budget.totalMs).toBeLessThan(budget.ceilingMs)
  })

  it('sums the terms rather than restating a total', () => {
    const budget = pauseLatencyBudget()
    const summed = budget.terms.reduce((total, term) => total + term.budgetMs, 0)

    expect(budget.totalMs).toBe(summed)
    expect(summed).toBe(
      POLL_INTERVAL_MS +
        PULL_ROUND_TRIP_MS +
        QUIESCE_BUDGET_MS +
        SNAPSHOT_BUDGET_MS +
        ACKNOWLEDGE_BUDGET_MS,
    )
  })

  it('names every term of the path, so none is budgeted by omission', () => {
    expect(pauseLatencyBudget().terms.map((term) => term.name)).toStrictEqual([
      'poll-interval',
      'pull-round-trip',
      'quiesce',
      'snapshot',
      'acknowledge',
    ])
  })

  it('gives quiesce the largest share, because it is the term that bounds turn length', () => {
    const budget = pauseLatencyBudget()
    const [largest] = [...budget.terms].sort((left, right) => right.budgetMs - left.budgetMs)

    expect(largest.name).toBe('quiesce')
  })

  it('keeps the poll interval a small fraction of the ceiling', () => {
    // A five-second interval would consume half the budget in the first term alone.
    expect(POLL_INTERVAL_MS).toBeLessThanOrEqual(PAUSE_LATENCY_CEILING_MS / 4)
  })

  it('leaves the acknowledgement inside the budget, because that is when the user is told', () => {
    // FR-049 puts acknowledgement after snapshot registration, so both terms are inside SC-003.
    const budget = pauseLatencyBudget()
    const names = budget.terms.map((term) => term.name)

    expect(names).toContain('snapshot')
    expect(names.indexOf('acknowledge')).toBeGreaterThan(names.indexOf('snapshot'))
  })
})
