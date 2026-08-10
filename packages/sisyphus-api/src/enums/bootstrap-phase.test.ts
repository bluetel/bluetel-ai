import { describe, expect, it } from 'vitest'

import {
  BOOTSTRAP_PHASES,
  isBootstrapPhase,
  isValidationBootstrapPhase,
  VALIDATION_BOOTSTRAP_PHASES,
} from './bootstrap-phase'

describe('BOOTSTRAP_PHASES', () => {
  it('runs in executor-protocol order, which is what lets a timeout name a step (FR-146)', () => {
    expect([...BOOTSTRAP_PHASES]).toStrictEqual([
      'provisioning',
      'bundle_download',
      'bundle_verify',
      'bundle_unpack',
      'setup_script',
      'credential_install',
      'entry_checkout',
      'agent_start',
    ])
  })

  it('installs the agent credential between the setup script and the checkout (003/FR-049, R7)', () => {
    // Position, not membership, is the assertion. The credential must be installed *after* the
    // bundle has put the agent CLI in place and *before* any workspace work begins, so this is a
    // mid-order insert — appending it to dodge the migration would place credential installation
    // after `agent_start` in the vocabulary, which is wrong and undetectable once rows refer to it.
    expect(BOOTSTRAP_PHASES.indexOf('setup_script')).toBeLessThan(
      BOOTSTRAP_PHASES.indexOf('credential_install'),
    )
    expect(BOOTSTRAP_PHASES.indexOf('credential_install')).toBeLessThan(
      BOOTSTRAP_PHASES.indexOf('entry_checkout'),
    )
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

describe('VALIDATION_BOOTSTRAP_PHASES', () => {
  it('is a prefix of the full sequence rather than an arbitrary subset (FR-147)', () => {
    // The claim a validation makes is "the beginning of a real boot works". A subset with holes in
    // it would be a different sequence wearing the same names, and would prove less than it looks.
    expect([...BOOTSTRAP_PHASES].slice(0, VALIDATION_BOOTSTRAP_PHASES.length)).toStrictEqual([
      ...VALIDATION_BOOTSTRAP_PHASES,
    ])
  })

  it('stops at the setup script, before anything a validation has no input for', () => {
    expect(VALIDATION_BOOTSTRAP_PHASES.at(-1)).toBe('setup_script')
    // No workspace, no prompt, no leased seat — so these three are not phases a validation skipped,
    // they are phases that do not exist for it (FR-147, 003/FR-052).
    for (const phase of ['credential_install', 'entry_checkout', 'agent_start'] as const) {
      expect(isValidationBootstrapPhase(phase)).toBe(false)
      expect(isBootstrapPhase(phase)).toBe(true)
    }
  })

  it('guards membership', () => {
    expect(isValidationBootstrapPhase('bundle_verify')).toBe(true)
    expect(isValidationBootstrapPhase('warming_up')).toBe(false)
  })
})
