import { describe, expect, it } from 'vitest'

import * as barrel from './index'

/**
 * The barrel is the directory's public surface, so what it does — and does not — export is a
 * contract in its own right (FR-004).
 */
describe('the machine barrel', () => {
  it('exports the router root.ts mounts at /api/machine', () => {
    expect(typeof barrel.machineSurfaceRouter).toBe('object')
  })

  it('exports each reporter, so the reconciler can call one without a router', () => {
    for (const name of [
      'heartbeat',
      'reportBootstrapPhase',
      'appendLogSegment',
      'reportTerminal',
      'renewCredential',
      'registerArtifact',
      'reportEntryResult',
      'reportEntryCheckout',
      'registerSnapshot',
      'reportReviewerSummary',
      'reportSkillReference',
      'reportExternalAction',
    ] as const) {
      expect(typeof barrel[name]).toBe('function')
    }
  })

  it('exports the audit path the entry-result guard records under', () => {
    expect(barrel.REPORT_ENTRY_RESULT_PATH).toBe('machine.reportEntryResult')
  })

  it('exports the skill-reference audit path and the external-action progression rule', () => {
    expect(barrel.REPORT_SKILL_REFERENCE_PATH).toBe('machine.reportSkillReference')
    // Named so a reader can find the index the exactly-once guarantee actually rests on.
    expect(barrel.EXTERNAL_ACTION_IDEMPOTENCY_INDEX).toBe('external_actions_idempotency_key')
    expect(barrel.supersedesExternalActionResult('succeeded', 'failed')).toBe(false)
  })

  it('exports the audit paths the two newly mounted guards record under', () => {
    expect(barrel.REPORT_ENTRY_CHECKOUT_PATH).toBe('machine.reportEntryCheckout')
    expect(barrel.REGISTER_SNAPSHOT_PATH).toBe('machine.registerSnapshot')
  })

  it('exports the cross-workflow guard as the single checked entry point', () => {
    expect(typeof barrel.requireEntryInWorkflow).toBe('function')
    expect(typeof barrel.resolveOptionalEntry).toBe('function')
  })

  it('does not export the fixture seeder', () => {
    expect(Object.keys(barrel)).not.toContain('createMachineFixture')
    expect(Object.keys(barrel)).not.toContain('readTestDatabaseUrl')
  })
})
