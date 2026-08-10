import { describe, expect, it } from 'vitest'

import { PAUSE_IDLE_CEILING_MS } from './pause-idle'

/**
 * The value itself is the contract. Three applications enforce it and none of them can see the
 * others, so the assertion that matters is that it is one number with one definition — the panel's
 * countdown, the executor's timer and the reconciler's backstop all read this module.
 */
describe('PAUSE_IDLE_CEILING_MS', () => {
  it('is thirty minutes', () => {
    expect(PAUSE_IDLE_CEILING_MS).toBe(30 * 60_000)
  })

  it('is long enough to be a pause rather than a hiccup, and short enough to be a limit', () => {
    // The bounds rather than the value, so a deliberate re-tune inside them does not have to
    // rewrite this suite, while a units mistake — seconds for milliseconds, minutes for hours —
    // fails immediately.
    expect(PAUSE_IDLE_CEILING_MS).toBeGreaterThanOrEqual(10 * 60_000)
    expect(PAUSE_IDLE_CEILING_MS).toBeLessThanOrEqual(4 * 60 * 60_000)
  })
})
