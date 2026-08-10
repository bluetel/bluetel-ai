import { describe, expect, it } from 'vitest'

import * as barrel from './index'

/**
 * The barrel is the directory's public surface, so what it does — and does not — export is a
 * contract in its own right.
 */
describe('the jobs barrel', () => {
  it('exports the integration tick and the listener that triggers it', () => {
    for (const name of [
      'integrationTick',
      'runIntegrationTick',
      'startTickSignalListener',
      'createManualTicker',
      'createSqlTickSignalSource',
      'runTickTransportProbe',
    ] as const) {
      expect(typeof barrel[name]).toBe('function')
    }

    expect(barrel.TICK_SIGNAL_CHANNEL).toBe('sisyphus_integration_tick')
  })

  it('exports the prompt assembly and redaction the tick composes', () => {
    for (const name of [
      'assemblePrompt',
      'assembleIntegrationPrompt',
      'redactPromptParts',
      'boundComments',
      'createRefusingPromptRedactor',
      'checkRedactorConformance',
    ] as const) {
      expect(typeof barrel[name]).toBe('function')
    }
  })

  it('exports the integration store, health tracking and schedule sync', () => {
    for (const name of [
      'claimAndStart',
      'findOpenRun',
      'recordRunOutcome',
      'wasAutoDisabled',
      'syncSchedules',
      'runSyncSchedules',
      'scheduleNameFor',
    ] as const) {
      expect(typeof barrel[name]).toBe('function')
    }
  })

  it('exports the cost-basis job and the pricing it is built from (FR-041)', () => {
    for (const name of [
      'recordCostBasis',
      'runRecordCostBasis',
      'summariseComputeCost',
      'billableMs',
      'computeCost',
      'createRateCard',
      'rateCardKey',
    ] as const) {
      expect(typeof barrel[name]).toBe('function')
    }

    expect(barrel.COST_BASIS_JOB_NAME).toBe('record-cost-basis')
  })

  it('exposes the live figure separately from the write, so a running run can be priced', () => {
    // `summariseComputeCost` on the barrel is what lets the panel show a cost for a lease that has
    // not been released. If only `recordCostBasis` were exported, the only way to a figure would be
    // to commit one.
    expect(Object.keys(barrel)).toContain('summariseComputeCost')
  })

  it('exports both halves of the FR-192 seam — the empty map and the root that fills it', () => {
    expect(createRegistryTypes(barrel.createConnectorRegistry())).toStrictEqual([])
    expect(createRegistryTypes(barrel.createRegisteredConnectorRegistry())).toStrictEqual(
      barrel.REGISTERED_CONNECTOR_TYPES,
    )
  })

  it('exports the agent-credential lifecycle the jobs share (003/FR-019, FR-012)', () => {
    for (const name of [
      'releasesAgentCredential',
      'isTerminalWorkflowState',
      'agentCredentialFor',
    ] as const) {
      expect(typeof barrel[name]).toBe('function')
    }

    // One definition of "terminal, but not merely parked". A second copy is how the park case ends
    // up forgotten once, and once is an agent losing its identity mid-run.
    expect(barrel.AGENT_CREDENTIAL_RETAINING_OUTCOME).toBe('parked_resumable')
    expect(barrel.releasesAgentCredential('parked_resumable')).toBe(false)
    expect(barrel.releasesAgentCredential('paused')).toBe(false)
    expect(barrel.releasesAgentCredential('failed')).toBe(true)
  })

  it('exports the pause, the park and the resume that undoes them (003/FR-039, FR-041, FR-044)', () => {
    for (const name of [
      'pauseInstance',
      'runPauseInstance',
      'resumeWorkflow',
      'runResumeWorkflow',
      'resumableSnapshotFor',
      'giveUpEnvironment',
    ] as const) {
      expect(typeof barrel[name]).toBe('function')
    }

    // The job names are what a schedule or a direct invocation has to spell, so they are asserted
    // as values rather than merely as present keys.
    expect(barrel.PAUSE_INSTANCE_JOB_NAME).toBe('pause-instance')
    expect(barrel.RESUME_WORKFLOW_JOB_NAME).toBe('resume-workflow')
  })

  it('publishes one QueueDrain, not two', () => {
    // `pause-instance.ts` declares a structurally identical one. Re-exporting both would be a
    // collision resolved by export order; the drain a deployment wires satisfies both jobs.
    const drain: barrel.QueueDrain = { drain: async () => Promise.resolve() }

    expect(typeof drain.drain).toBe('function')
  })

  it('does not export the test support', () => {
    // A fixture seeder or a connector that ticks nothing and reports success, one import away from
    // a job, is the thing this barrel is careful about.
    for (const name of [
      'createFakeConnector',
      'fakeConnectorFactory',
      'fakeCandidate',
      'createIntegrationFixture',
      'createWorkflowFixture',
    ]) {
      expect(Object.keys(barrel)).not.toContain(name)
    }
  })
})

const createRegistryTypes = (registry: { types: () => readonly string[] }): readonly string[] =>
  registry.types()
