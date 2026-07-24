import { describe, it, expect } from 'vitest'

import { clampInterval } from './use-polling'

describe('clampInterval', () => {
  it('returns 1000 for values below minimum', () => {
    expect(clampInterval(0)).toBe(1000)
    expect(clampInterval(500)).toBe(1000)
    expect(clampInterval(-100)).toBe(1000)
    expect(clampInterval(999)).toBe(1000)
  })

  it('returns 60000 for values above maximum', () => {
    expect(clampInterval(60001)).toBe(60000)
    expect(clampInterval(100000)).toBe(60000)
    expect(clampInterval(Infinity)).toBe(60000)
  })

  it('returns the value unchanged when within range', () => {
    expect(clampInterval(1000)).toBe(1000)
    expect(clampInterval(5000)).toBe(5000)
    expect(clampInterval(30000)).toBe(30000)
    expect(clampInterval(60000)).toBe(60000)
  })

  it('handles boundary values exactly', () => {
    expect(clampInterval(1000)).toBe(1000)
    expect(clampInterval(60000)).toBe(60000)
    expect(clampInterval(1001)).toBe(1001)
    expect(clampInterval(59999)).toBe(59999)
  })

  it('handles NaN by returning 1000 (clamped minimum)', () => {
    expect(clampInterval(NaN)).toBe(1000)
  })
})
