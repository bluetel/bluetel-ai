import { describe, expect, it } from 'vitest'

import { isTerminalOutcome, TERMINAL_OUTCOMES } from './terminal-outcome'

describe('TERMINAL_OUTCOMES', () => {
  it('is FR-064 verbatim, in order', () => {
    expect([...TERMINAL_OUTCOMES]).toStrictEqual([
      'succeeded',
      'failed',
      'capped',
      'cancelled',
      'needs_attention',
      'parked_resumable',
    ])
  })

  it('holds no duplicates', () => {
    expect(new Set(TERMINAL_OUTCOMES).size).toBe(TERMINAL_OUTCOMES.length)
  })

  it('records Stop as cancelled rather than as a failure (FR-049)', () => {
    expect(TERMINAL_OUTCOMES).toContain('cancelled')
  })

  it('guards membership', () => {
    expect(isTerminalOutcome('parked_resumable')).toBe(true)
    expect(isTerminalOutcome('stopped')).toBe(false)
    expect(isTerminalOutcome('running')).toBe(false)
  })
})
