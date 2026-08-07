import { describe, expect, it } from 'vitest'

import {
  formatLatencySummary,
  percentile,
  summariseLatencies,
  VISIBILITY_BUDGET_MS,
} from './latency-stats'

describe('percentile', () => {
  it('returns null for an empty sample', () => {
    expect(percentile([], 0.95)).toBeNull()
  })

  it('uses nearest rank rather than interpolation', () => {
    const sorted = [10, 20, 30, 40]
    expect(percentile(sorted, 0.5)).toBe(20)
    expect(percentile(sorted, 0.95)).toBe(40)
  })

  it('clamps to the first and last element', () => {
    expect(percentile([5, 6, 7], 0)).toBe(5)
    expect(percentile([5, 6, 7], 1)).toBe(7)
  })
})

describe('summariseLatencies', () => {
  it('scores the budget against segments produced, not segments received', () => {
    // The silent-failure shape: three fast arrivals out of a hundred produced.
    const summary = summariseLatencies([1, 2, 3], 100)
    expect(summary.sampleCount).toBe(3)
    expect(summary.producedCount).toBe(100)
    expect(summary.fractionWithinBudget).toBeCloseTo(0.03)
    expect(summary.meetsSc002).toBe(false)
  })

  it('passes SC-002 when at least 95 per cent arrive inside the budget', () => {
    const samples = [
      ...Array.from({ length: 96 }, () => 120),
      ...Array.from({ length: 4 }, () => VISIBILITY_BUDGET_MS + 1),
    ]
    const summary = summariseLatencies(samples, 100)
    expect(summary.fractionWithinBudget).toBeCloseTo(0.96)
    expect(summary.meetsSc002).toBe(true)
  })

  it('treats a latency exactly at the budget as outside it', () => {
    const summary = summariseLatencies([VISIBILITY_BUDGET_MS], 1)
    expect(summary.fractionWithinBudget).toBe(0)
  })

  it('reports nulls rather than zeroes when nothing was observed', () => {
    const summary = summariseLatencies([], 250)
    expect(summary.p50Ms).toBeNull()
    expect(summary.p95Ms).toBeNull()
    expect(summary.maxMs).toBeNull()
    expect(summary.fractionWithinBudget).toBe(0)
    expect(summary.meetsSc002).toBe(false)
  })

  it('does not divide by zero when nothing was produced', () => {
    expect(summariseLatencies([], 0).fractionWithinBudget).toBe(0)
  })
})

describe('formatLatencySummary', () => {
  it('renders the verdict alongside the distribution', () => {
    const line = formatLatencySummary('listen-notify', summariseLatencies([1, 2, 3], 3))
    expect(line).toContain('listen-notify')
    expect(line).toContain('n=3/3')
    expect(line).toContain('SC-002 PASS')
  })

  it('renders n/a for an empty distribution', () => {
    const line = formatLatencySummary('pooled', summariseLatencies([], 300))
    expect(line).toContain('p50=n/a')
    expect(line).toContain('SC-002 FAIL')
  })
})
