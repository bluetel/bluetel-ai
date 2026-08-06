import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createExternalActionLedger } from '../delivery'
import type { SkillSource } from '../skills'

import type {
  DeclaredIntegrationPlan,
  IntegrationPort,
  IntegrationStepRef,
} from './integration-step'
import { INTEGRATION_STEP, resolveIntegrationPlan, runIntegrationStep } from './integration-step'

/**
 * The `sisyphus-integration` step — order from the skill, halts on silence, and a partial state
 * that is stated rather than implied (FR-057, FR-058, FR-117, FR-118).
 */

const WORKFLOW_ID = '019fd631-15bf-7a03-a1c6-ff6d568c2654'
const SKILL_BODY = 'Land the schema first, then the caller. Never the other way round.'

const source = async (present = true): Promise<SkillSource> => {
  const root = await mkdtemp(join(tmpdir(), 'sisyphus-integration-'))

  if (present) {
    const path = join(root, '.claude', 'skills', 'sisyphus-integration', 'SKILL.md')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, SKILL_BODY, 'utf8')
  }

  return { entryId: 'entry-api', path: root }
}

const recordingIntegrator = (
  failOn?: string,
): { readonly port: IntegrationPort; readonly performed: readonly string[] } => {
  const performed: string[] = []

  return {
    performed,
    port: async ({ entryId, name }) => {
      if (name === failOn) {
        return Promise.reject(new Error(`${name} was rejected by the forge`))
      }

      performed.push(`${entryId}/${name}`)
      return Promise.resolve({ entryId, name, reference: `ref-${entryId}-${name}` })
    },
  }
}

const plan = (declared: DeclaredIntegrationPlan) => async () => Promise.resolve(declared)

const twoEntries = [{ entryId: 'entry-api' }, { entryId: 'entry-client' }]

describe('runIntegrationStep', () => {
  it('performs the steps in the order the skill declared, not the order it listed them', async () => {
    const integrator = recordingIntegrator()

    const outcome = await runIntegrationStep({
      workflowId: WORKFLOW_ID,
      source: await source(),
      report: () => undefined,
      planner: plan({
        order: { entryIds: ['entry-api', 'entry-client'] },
        steps: [
          { entryId: 'entry-client', name: 'promote', instruction: 'Promote the caller.' },
          { entryId: 'entry-api', name: 'promote', instruction: 'Promote the schema.' },
        ],
      }),
      integrator: integrator.port,
      entries: twoEntries,
      ledger: createExternalActionLedger<IntegrationStepRef>(),
    })

    expect(integrator.performed).toEqual(['entry-api/promote', 'entry-client/promote'])
    expect(outcome.order).toEqual(['entry-api', 'entry-client'])
    expect(outcome.complete).toBe(true)
  })

  it('halts when the skill is missing (FR-058)', async () => {
    await expect(
      runIntegrationStep({
        workflowId: WORKFLOW_ID,
        source: await source(false),
        report: () => undefined,
        planner: plan({}),
        integrator: recordingIntegrator().port,
        entries: twoEntries,
        ledger: createExternalActionLedger<IntegrationStepRef>(),
      }),
    ).rejects.toThrow(/sisyphus-integration skill is missing/iu)
  })

  it('halts rather than choosing an order across a client’s repositories (FR-117)', async () => {
    await expect(
      runIntegrationStep({
        workflowId: WORKFLOW_ID,
        source: await source(),
        report: () => undefined,
        planner: plan({ steps: [] }),
        integrator: recordingIntegrator().port,
        entries: twoEntries,
        ledger: createExternalActionLedger<IntegrationStepRef>(),
      }),
    ).rejects.toThrow(/states no order for them/iu)
  })

  it('orders a single repository without a declaration — one permutation chooses nothing', async () => {
    const integrator = recordingIntegrator()

    const outcome = await runIntegrationStep({
      workflowId: WORKFLOW_ID,
      source: await source(),
      report: () => undefined,
      planner: plan({
        steps: [{ entryId: 'entry-api', name: 'promote', instruction: 'Promote it.' }],
      }),
      integrator: integrator.port,
      entries: [{ entryId: 'entry-api' }],
      ledger: createExternalActionLedger<IntegrationStepRef>(),
    })

    expect(outcome.order).toEqual(['entry-api'])
    expect(integrator.performed).toEqual(['entry-api/promote'])
  })

  it('halts when the skill prescribes a step for a repository its own order does not place', async () => {
    await expect(
      runIntegrationStep({
        workflowId: WORKFLOW_ID,
        source: await source(),
        report: () => undefined,
        planner: plan({
          order: { entryIds: ['entry-api', 'entry-client'] },
          steps: [{ entryId: 'entry-elsewhere', name: 'promote', instruction: 'Promote it.' }],
        }),
        integrator: recordingIntegrator().port,
        entries: twoEntries,
        ledger: createExternalActionLedger<IntegrationStepRef>(),
      }),
    ).rejects.toThrow(/contradicts itself/iu)
  })

  it('stops at the first failure and marks the rest not attempted (FR-118)', async () => {
    const integrator = recordingIntegrator('promote')

    const outcome = await runIntegrationStep({
      workflowId: WORKFLOW_ID,
      source: await source(),
      report: () => undefined,
      planner: plan({
        order: { entryIds: ['entry-api', 'entry-client'] },
        steps: [
          { entryId: 'entry-api', name: 'tag', instruction: 'Tag the release.' },
          { entryId: 'entry-api', name: 'promote', instruction: 'Promote the schema.' },
          { entryId: 'entry-client', name: 'promote', instruction: 'Promote the caller.' },
        ],
      }),
      integrator: integrator.port,
      entries: twoEntries,
      ledger: createExternalActionLedger<IntegrationStepRef>(),
    })

    expect(outcome.results.map((result) => result.status)).toEqual([
      'performed',
      'failed',
      'not_attempted',
    ])
    expect(outcome.complete).toBe(false)
    expect(outcome.isPartial).toBe(true)
    expect(outcome.statement).toContain('partial integration, not a success')
  })

  it('says plainly when the skill prescribes nothing at all', async () => {
    const outcome = await runIntegrationStep({
      workflowId: WORKFLOW_ID,
      source: await source(),
      report: () => undefined,
      planner: plan({ steps: [] }),
      integrator: recordingIntegrator().port,
      entries: [{ entryId: 'entry-api' }],
      ledger: createExternalActionLedger<IntegrationStepRef>(),
    })

    expect(outcome.results).toEqual([])
    expect(outcome.statement).toContain('prescribes no integration steps')
  })

  it('does not perform a step twice when the run retries it (FR-076)', async () => {
    const integrator = recordingIntegrator()
    const ledger = createExternalActionLedger<IntegrationStepRef>()
    const request = {
      workflowId: WORKFLOW_ID,
      source: await source(),
      report: () => undefined,
      planner: plan({
        steps: [{ entryId: 'entry-api', name: 'promote', instruction: 'Promote it.' }],
      }),
      integrator: integrator.port,
      entries: [{ entryId: 'entry-api' }],
      ledger,
    }

    await runIntegrationStep(request)
    await runIntegrationStep(request)

    expect(integrator.performed).toEqual(['entry-api/promote'])
  })

  it('acts on the reading it was given rather than reading the skill twice', async () => {
    let plannerCalls = 0
    const resolved = await resolveIntegrationPlan({
      source: await source(),
      report: () => undefined,
      planner: async () => {
        plannerCalls += 1
        return Promise.resolve({
          steps: [{ entryId: 'entry-api', name: 'promote', instruction: 'Promote it.' }],
        })
      },
    })

    await runIntegrationStep({
      workflowId: WORKFLOW_ID,
      source: await source(false),
      report: () => undefined,
      planner: async () => {
        plannerCalls += 1
        return Promise.resolve({})
      },
      integrator: recordingIntegrator().port,
      entries: [{ entryId: 'entry-api' }],
      ledger: createExternalActionLedger<IntegrationStepRef>(),
      resolved,
    })

    expect(plannerCalls).toBe(1)
    expect(resolved.skill.skillName).toBe('sisyphus-integration')
  })
})

describe('resolveIntegrationPlan', () => {
  it('reports the skill it read at the integrate step (FR-059)', async () => {
    const phases: (string | undefined)[] = []

    await resolveIntegrationPlan({
      source: await source(),
      report: (report) => {
        phases.push(report.phase)
      },
      planner: plan({}),
    })

    expect(phases).toEqual([INTEGRATION_STEP])
  })
})
