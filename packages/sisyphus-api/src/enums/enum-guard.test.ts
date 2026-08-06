import { describe, expect, it } from 'vitest'

import { createEnumGuard } from './enum-guard'

describe('createEnumGuard', () => {
  const isColour = createEnumGuard(['red', 'green'] as const)

  it('accepts members of the set', () => {
    expect(isColour('red')).toBe(true)
    expect(isColour('green')).toBe(true)
  })

  it('rejects non-members', () => {
    expect(isColour('blue')).toBe(false)
    expect(isColour('')).toBe(false)
  })

  it('rejects non-string input rather than coercing it', () => {
    expect(isColour(undefined)).toBe(false)
    expect(isColour(null)).toBe(false)
    expect(isColour(0)).toBe(false)
    expect(isColour(['red'])).toBe(false)
  })

  it('does not treat inherited array members as values', () => {
    expect(isColour('length')).toBe(false)
    expect(isColour('toString')).toBe(false)
  })
})
