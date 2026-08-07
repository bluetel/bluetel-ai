import { describe, expect, it } from 'vitest'

import { BOOTSTRAP_PHASES, isBootstrapPhase } from './bootstrap-phase'

describe('BOOTSTRAP_PHASES', () => {
  it('runs in executor-protocol order, which is what lets a timeout name a step (FR-146)', () => {
    expect([...BOOTSTRAP_PHASES]).toStrictEqual([
      'provisioning',
      'bundle_download',
      'bundle_verify',
      'bundle_unpack',
      'setup_script',
      'entry_checkout',
      'agent_start',
    ])
  })

  it('verifies a bundle before unpacking it', () => {
    expect(BOOTSTRAP_PHASES.indexOf('bundle_verify')).toBeLessThan(
      BOOTSTRAP_PHASES.indexOf('bundle_unpack'),
    )
  })

  it('starts the agent last, after the entries it will work on are checked out', () => {
    expect(BOOTSTRAP_PHASES.at(-1)).toBe('agent_start')
    expect(BOOTSTRAP_PHASES.indexOf('entry_checkout')).toBeLessThan(
      BOOTSTRAP_PHASES.indexOf('agent_start'),
    )
  })

  it('guards membership', () => {
    expect(isBootstrapPhase('setup_script')).toBe(true)
    expect(isBootstrapPhase('warming_up')).toBe(false)
  })
})
