import { describe, expect, it } from 'vitest'

import { DEFAULT_PURCHASE_MODE, isPurchaseMode, PURCHASE_MODES } from './purchase-mode'

describe('PURCHASE_MODES', () => {
  it('offers interruptible and on-demand capacity', () => {
    expect([...PURCHASE_MODES]).toStrictEqual(['spot', 'on_demand'])
  })

  it('defaults to interruptible capacity (research.md R7)', () => {
    expect(DEFAULT_PURCHASE_MODE).toBe('spot')
    expect(PURCHASE_MODES).toContain(DEFAULT_PURCHASE_MODE)
  })

  it('guards membership', () => {
    expect(isPurchaseMode('on_demand')).toBe(true)
    expect(isPurchaseMode('on-demand')).toBe(false)
  })
})
