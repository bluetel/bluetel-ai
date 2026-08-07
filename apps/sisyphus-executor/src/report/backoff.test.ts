import { describe, expect, it, vi } from 'vitest'

import { createBackoff, DEFAULT_INITIAL_DELAY_MS, DEFAULT_MAX_DELAY_MS, sleep } from './backoff'

describe('createBackoff', () => {
  it('grows the ceiling geometrically', () => {
    const backoff = createBackoff({ initialDelayMs: 100, factor: 2, random: () => 1 })

    expect([1, 2, 3, 4].map((attempt) => backoff.delayFor(attempt))).toEqual([100, 200, 400, 800])
  })

  it('stops growing at the ceiling', () => {
    const backoff = createBackoff({
      initialDelayMs: 100,
      factor: 10,
      maxDelayMs: 5_000,
      random: () => 1,
    })

    expect(backoff.delayFor(5)).toBe(5_000)
    expect(backoff.delayFor(50)).toBe(5_000)
  })

  it('draws the delay from the whole interval, so a fleet does not reconverge', () => {
    const draws = [0, 0.5, 1]
    let index = 0
    const backoff = createBackoff({
      initialDelayMs: 1_000,
      random: () => {
        const value = draws[index] ?? 0
        index += 1

        return value
      },
    })

    expect([backoff.delayFor(1), backoff.delayFor(1), backoff.delayFor(1)]).toEqual([0, 500, 1_000])
  })

  it('never produces a shrinking first delay from an out-of-range attempt', () => {
    const backoff = createBackoff({ initialDelayMs: 100, random: () => 1 })

    expect(backoff.delayFor(0)).toBe(100)
    expect(backoff.delayFor(-7)).toBe(100)
  })

  it('defaults to a schedule that is patient rather than aggressive', () => {
    const backoff = createBackoff({ random: () => 1 })

    expect(backoff.delayFor(1)).toBe(DEFAULT_INITIAL_DELAY_MS)
    expect(backoff.delayFor(100)).toBe(DEFAULT_MAX_DELAY_MS)
  })
})

describe('sleep', () => {
  it('resolves after the requested delay', async () => {
    vi.useFakeTimers()

    try {
      let resolved = false
      const waiting = sleep(500).then(() => {
        resolved = true
      })

      await vi.advanceTimersByTimeAsync(499)
      expect(resolved).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      await waiting
      expect(resolved).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
