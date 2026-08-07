import { describe, expect, it } from 'vitest'

import { uuidV7, uuidV7TimestampMs } from './uuid-v7'

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('uuidV7', () => {
  it('produces a canonical 36-character uuid', () => {
    const id = uuidV7()
    expect(id).toHaveLength(36)
    expect(id).toMatch(UUID_SHAPE)
  })

  it('sets the version nibble to 7 and the RFC 9562 variant', () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const id = uuidV7()
      expect(id[14]).toBe('7')
      expect(['8', '9', 'a', 'b']).toContain(id[19])
    }
  })

  it('round-trips the embedded timestamp', () => {
    const when = Date.UTC(2026, 7, 5, 12, 34, 56, 789)
    expect(uuidV7TimestampMs(uuidV7(when))).toBe(when)
  })

  it('sorts lexicographically in timestamp order, which is why the key is v7 and not v4', () => {
    const early = uuidV7(1_700_000_000_000)
    const late = uuidV7(1_700_000_000_001)
    const later = uuidV7(1_900_000_000_000)
    expect([later, early, late].sort()).toStrictEqual([early, late, later])
  })

  it('does not collide across a large batch at a single instant', () => {
    const fixed = 1_700_000_000_000
    const ids = new Set(Array.from({ length: 5_000 }, () => uuidV7(fixed)))
    expect(ids.size).toBe(5_000)
  })

  it('rejects a timestamp it cannot represent in 48 bits', () => {
    expect(() => uuidV7(-1)).toThrow(RangeError)
    expect(() => uuidV7(1.5)).toThrow(RangeError)
    expect(() => uuidV7(0xffffffffffff + 1)).toThrow(RangeError)
  })

  it('accepts the boundary values', () => {
    expect(uuidV7(0)).toMatch(/^00000000-0000-7/)
    expect(uuidV7TimestampMs(uuidV7(0xffffffffffff))).toBe(0xffffffffffff)
  })
})
