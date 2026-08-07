import { describe, expect, it } from 'vitest'

import { FOCUS_RING } from './focus-ring'

describe('FOCUS_RING', () => {
  it('is the single class name the stylesheet defines the ring against', () => {
    expect(FOCUS_RING).toBe('focus-ring')
  })

  it('carries no colour or width of its own, so the treatment cannot fork per primitive', () => {
    expect(FOCUS_RING).not.toMatch(/signal|outline|ring-/)
  })
})
