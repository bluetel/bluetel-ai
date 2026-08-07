import { describe, expect, it } from 'vitest'

import { BOOTSTRAP_PHASE_OUTCOMES, isBootstrapPhaseOutcome } from './bootstrap-phase-outcome'

describe('BOOTSTRAP_PHASE_OUTCOMES', () => {
  it('separates a timeout from a failure, so a budget that was too small is nameable', () => {
    expect([...BOOTSTRAP_PHASE_OUTCOMES]).toStrictEqual(['succeeded', 'failed', 'timed_out'])
  })

  it('guards membership', () => {
    expect(isBootstrapPhaseOutcome('timed_out')).toBe(true)
    expect(isBootstrapPhaseOutcome('cancelled')).toBe(false)
  })
})
