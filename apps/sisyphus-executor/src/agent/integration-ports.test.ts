/**
 * T196 — the integration planner and the integration port.
 *
 * Two assertions carry most of the weight. **The step's identity is the request's**: an agent that
 * answers with a different entry id must not be able to file one repository's merge as evidence
 * that another was merged. And **a step with no reference is a failed step**: `runIntegrationStep`
 * turns the rejection into FR-118's partial state, which is the whole difference between "we merged
 * two of three" and plain success.
 */

import { describe, expect, it } from 'vitest'

import type { ResolvedSkill } from '../skills'

import type { AgentFrame, AgentResultFrame } from './adapter'
import { createFrameTap } from './frame-tap'
import { AgentIntegrationError, createAgentIntegrationPorts } from './integration-ports'
import { INTEGRATION_PLAN_TAG, INTEGRATION_STEP_TAG } from './integration-turn'
import { answerMarkers } from './proposal-block'

const NONCE = 'de1e7e00'

const skill: ResolvedSkill = {
  skillName: 'sisyphus-integration',
  entryId: 'a3f0c2d4-0000-4000-8000-000000000001',
  resolvedPath: '.claude/skills/sisyphus-integration/SKILL.md',
  absolutePath: '/workspace/primary/.claude/skills/sisyphus-integration/SKILL.md',
  contentDigest: 'ab12cd34'.repeat(8),
  byteSize: 210,
  body: 'The client’s integration rules.',
}

const blockFor = (tag: string, value: unknown): string => {
  const { open, close } = answerMarkers(tag, NONCE)

  return `${open}\n${JSON.stringify(value)}\n${close}`
}

const assistant = (text: string): AgentFrame => ({ type: 'assistant', text })

const result = (over: Partial<AgentResultFrame> = {}): AgentFrame => ({
  type: 'result',
  subtype: 'success',
  isError: false,
  usage: { turns: 1, spendUsd: 0.01 },
  ...over,
})

interface Harness {
  readonly ports: ReturnType<typeof createAgentIntegrationPorts>
  readonly tap: ReturnType<typeof createFrameTap>
  readonly sent: string[]
  /** Resolves each time a turn reaches the agent, so a test never emits a frame too early. */
  readonly nextTurn: () => Promise<void>
}

const harnessFor = (options: { readonly settleMs?: number } = {}): Harness => {
  const tap = createFrameTap()
  const sent: string[] = []
  const waiting: (() => void)[] = []

  const ports = createAgentIntegrationPorts({
    agent: {
      sendTurn: (body) => {
        sent.push(body)
        // A macrotask, so the port has finished its own post-write bookkeeping first.
        setTimeout(() => waiting.shift()?.(), 0)

        return Promise.resolve({ acknowledged: true, latencyMs: 1 })
      },
    },
    frames: tap,
    nonce: () => NONCE,
    settleMs: options.settleMs ?? 20,
    planDeadlineMs: 5_000,
    stepDeadlineMs: 5_000,
  })

  return {
    ports,
    tap,
    sent,
    nextTurn: async () =>
      new Promise<void>((resolveTurn) => {
        waiting.push(resolveTurn)
      }),
  }
}

describe('createAgentIntegrationPorts — the plan', () => {
  it('returns the order and steps the agent read out of the skill', async () => {
    const harness = harnessFor()
    const written = harness.nextTurn()
    const plan = harness.ports.planner(skill)

    await written
    harness.tap.observe(
      assistant(
        blockFor(INTEGRATION_PLAN_TAG, {
          order: { entryIds: ['entry-api', 'entry-web'] },
          steps: [{ entryId: 'entry-api', name: 'merge', instruction: 'Merge it.' }],
        }),
      ),
    )

    await expect(plan).resolves.toStrictEqual({
      order: { entryIds: ['entry-api', 'entry-web'] },
      steps: [{ entryId: 'entry-api', name: 'merge', instruction: 'Merge it.' }],
    })
    expect(harness.sent[0]).toContain('The client’s integration rules.')
  })

  it('halts when the agent goes quiet rather than declaring an order of its own', async () => {
    const harness = harnessFor({ settleMs: 20 })
    const written = harness.nextTurn()
    const plan = harness.ports.planner(skill)

    await written
    harness.tap.observe(assistant('I read it.'))
    harness.tap.observe(result())

    const error = await plan.catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(AgentIntegrationError)
    expect(String(error)).toContain('reading sisyphus-integration')
  })
})

describe('createAgentIntegrationPorts — one step', () => {
  const request = {
    entryId: 'entry-api',
    name: 'merge',
    instruction: 'Merge the pull request.',
    idempotencyKey: 'integration-step:run:entry-api:merge',
  }

  it('takes only the reference from the agent, and keeps the request’s identity', async () => {
    const harness = harnessFor()
    const written = harness.nextTurn()
    const ref = harness.ports.integrator(request)

    await written
    // The agent answers about a different repository. Everything but the reference is ignored.
    harness.tap.observe(
      assistant(
        blockFor(INTEGRATION_STEP_TAG, {
          entryId: 'entry-web',
          name: 'promote',
          reference: 'https://forge.example/acme/api/commit/abc123',
        }),
      ),
    )

    await expect(ref).resolves.toStrictEqual({
      entryId: 'entry-api',
      name: 'merge',
      reference: 'https://forge.example/acme/api/commit/abc123',
    })
  })

  it('fails the step when the block names no reference', async () => {
    const harness = harnessFor()
    const written = harness.nextTurn()
    const ref = harness.ports.integrator(request)

    await written
    harness.tap.observe(assistant(blockFor(INTEGRATION_STEP_TAG, { reference: '   ' })))

    const error = await ref.catch((thrown: unknown) => thrown)

    expect(error).toMatchObject({ kind: 'unusable' })
    expect(String(error)).toContain('nothing a person could follow')
  })

  it('fails the step when the agent reports nothing at all', async () => {
    const harness = harnessFor({ settleMs: 20 })
    const written = harness.nextTurn()
    const ref = harness.ports.integrator(request)

    await written
    harness.tap.observe(assistant('The pipeline refused the merge.'))
    harness.tap.observe(result())

    await expect(ref).rejects.toThrow('integration step "merge" on entry entry-api')
  })

  it('names the plan’s reading of the skill once the planner has run (FR-059)', async () => {
    const harness = harnessFor()
    const plannerWritten = harness.nextTurn()
    const plan = harness.ports.planner(skill)

    await plannerWritten
    harness.tap.observe(assistant(blockFor(INTEGRATION_PLAN_TAG, { steps: [] })))
    await plan

    const stepWritten = harness.nextTurn()
    const ref = harness.ports.integrator(request)

    await stepWritten
    harness.tap.observe(assistant(blockFor(INTEGRATION_STEP_TAG, { reference: 'abc123' })))
    await ref

    expect(harness.sent[1]).toContain('ab12cd34'.repeat(8))
  })
})
