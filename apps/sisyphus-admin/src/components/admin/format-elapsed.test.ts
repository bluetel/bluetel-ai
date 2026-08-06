import { describe, expect, it } from 'vitest'

import { elapsedReadout, formatElapsed } from './format-elapsed'

describe('formatElapsed', () => {
  it.each([
    [0, '0:00'],
    [999, '0:00'],
    [1000, '0:01'],
    [9000, '0:09'],
    [59_000, '0:59'],
    [60_000, '1:00'],
    [261_000, '4:21'],
    [600_000, '10:00'],
  ])('renders %i ms as %s', (elapsed, expected) => {
    expect(formatElapsed(elapsed)).toBe(expected)
  })

  it('pads seconds but not minutes, so it reads as a stopwatch', () => {
    expect(formatElapsed(65_000)).toBe('1:05')
  })

  it('reads a backwards clock as no time at all rather than as a negative duration', () => {
    expect(formatElapsed(-5000)).toBe('0:00')
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('survives %s', (value) => {
    expect(formatElapsed(value)).toMatch(/^\d+:\d{2}$/)
  })
})

describe('elapsedReadout', () => {
  it('puts the action and the duration in one readout', () => {
    expect(elapsedReadout('Deactivating', 4000)).toBe('Deactivating 0:04')
  })

  it('keeps the verb sentence case, because buttons never take uppercase mono', () => {
    expect(elapsedReadout('Revoking', 0)).toBe('Revoking 0:00')
    expect(elapsedReadout('Revoking', 0)).not.toBe(elapsedReadout('Revoking', 0).toUpperCase())
  })
})
