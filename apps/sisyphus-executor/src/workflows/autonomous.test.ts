import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { AgentAdapter, AgentFrame, AgentUsage, AgentProcessSpecFactory } from '../agent'
import { createCliStreamAdapter, resolveTsxBinary, stubAgentEntry } from '../agent'
import { createCapEnforcer } from '../caps'
import type { Forge, GitReader, PullRequestSetEntry, PullRequestDelivery } from '../delivery'
import { createExternalActionLedger } from '../delivery'
import type { SkillSource } from '../skills'

import { runAutonomousWorkflow } from './autonomous'
import type { AutonomousWorkflowInput } from './autonomous'
import type { DevelopmentProposal } from './develop-step'
import type { IntegrationStepRef } from './integration-step'
import type { IterationRecord } from './iteration-record'
import type { ReviewProposal } from './review-step'
import type { TicketPort, TicketTransitionRef } from './ticket'

/**
 * The autonomous loop, end to end (FR-057, FR-061, FR-062, FR-064).
 *
 * No network, no git process, no paid inference. The two forge-facing ports are fakes, because the
 * thing under test is the composition rather than the verification those modules already own — and
 * one test drives the whole loop against the **stub agent process** from `src/agent`, over real
 * pipes, so "the loop runs an agent" is exercised rather than assumed.
 */

const WORKFLOW_ID = '019fd631-15bf-7a03-a1c6-ff6d568c2654'
const HEAD = 'a'.repeat(40)
const TICKET = 'ABC-1234'

const skillSource = async (
  skills: Readonly<Record<string, string>> = {
    'sisyphus-dev': 'Branch from whatever this repository calls its integration line.',
    'sisyphus-review': 'Block anything that changes behaviour without a test beside it.',
    'sisyphus-integration': 'Land it however this repository lands things.',
  },
): Promise<SkillSource> => {
  const root = await mkdtemp(join(tmpdir(), 'sisyphus-autonomous-'))

  for (const [name, body] of Object.entries(skills)) {
    const path = join(root, '.claude', 'skills', name, 'SKILL.md')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, body, 'utf8')
  }

  return { entryId: 'entry-a', path: root }
}

const fakeGit: GitReader = {
  headSha: async () => Promise.resolve(HEAD),
  resolveSha: async () => Promise.resolve(undefined),
  remoteSha: async () => Promise.resolve(undefined),
  fetchRef: async () => Promise.resolve(),
  countCommitsBetween: async () => Promise.resolve(undefined),
}

const fakeForge = (): Forge => {
  let next = 100

  return {
    branchHead: async () => Promise.resolve(HEAD),
    findPullRequest: async () => Promise.resolve(undefined),
    createPullRequest: async (input) => {
      next += 1
      return Promise.resolve({
        number: next,
        url: `https://git.test/app/pull/${String(next)}`,
        isDraft: input.draft,
      })
    },
  }
}

const entry = (entryId: string, repository: string): PullRequestSetEntry => ({
  entryId,
  repository,
  baseBranch: 'integration-line',
  wasChanged: true,
  git: fakeGit,
  forge: fakeForge(),
})

const proposal = (overrides: Partial<DevelopmentProposal> = {}): DevelopmentProposal => ({
  conventions: {
    remote: 'origin',
    branchName: 'ticket-1234-bounded-retry',
    baseBranch: 'integration-line',
    pullRequestTitle: 'ABC-1234 Bound the retry loop',
  },
  summary: {
    entries: [
      { repository: 'git.test/app', changed: true, description: 'Bounded the retry loop.' },
    ],
    decisions: [],
    assumptions: [],
    notDone: [],
    uncertainties: [],
  },
  ...overrides,
})

interface Harness {
  readonly input: AutonomousWorkflowInput
  readonly recorded: readonly IterationRecord[]
  readonly ticketMoves: readonly string[]
  readonly integrated: readonly string[]
}

const harness = async (options: {
  readonly verdicts: readonly ReviewProposal[]
  readonly entries?: readonly PullRequestSetEntry[]
  readonly usage?: () => AgentUsage
  readonly turnCap?: number
  readonly development?: Partial<DevelopmentProposal>
  readonly integrationSteps?: readonly { readonly entryId: string; readonly name: string }[]
  readonly order?: readonly string[]
  readonly source?: SkillSource
}): Promise<Harness> => {
  const recorded: IterationRecord[] = []
  const ticketMoves: string[] = []
  const integrated: string[] = []
  let reviewCall = 0

  const ticket: TicketPort = {
    transition: async ({ ticketReference, toState }) => {
      ticketMoves.push(toState)
      return Promise.resolve({ ticketReference, toState })
    },
  }

  return {
    recorded,
    ticketMoves,
    integrated,
    input: {
      workflowId: WORKFLOW_ID,
      source: options.source ?? (await skillSource()),
      report: () => undefined,
      developer: async () => Promise.resolve(proposal(options.development ?? {})),
      reviewer: async () => {
        const answer = options.verdicts.at(Math.min(reviewCall, options.verdicts.length - 1))
        reviewCall += 1
        return Promise.resolve(answer ?? { verdict: 'fail', findings: [] })
      },
      planner: async () =>
        Promise.resolve({
          ...(options.order === undefined ? {} : { order: { entryIds: options.order } }),
          steps: (options.integrationSteps ?? []).map((step) => ({
            ...step,
            instruction: 'However this repository lands things.',
          })),
        }),
      integrator: async ({ entryId, name }) => {
        integrated.push(`${entryId}/${name}`)
        return Promise.resolve({ entryId, name, reference: 'ref-1' })
      },
      entries: options.entries ?? [entry('entry-a', 'git.test/app')],
      ticketReference: TICKET,
      ticket,
      caps: createCapEnforcer({
        spendCapsEnforceable: true,
        ...(options.turnCap === undefined ? {} : { turnCap: options.turnCap }),
      }),
      usage: options.usage ?? ((): AgentUsage => ({ turns: 0, spendUsd: 0 })),
      recordIteration: async (record) => {
        recorded.push(record)
        return Promise.resolve()
      },
      pullRequestLedger: createExternalActionLedger<PullRequestDelivery>(),
      ticketLedger: createExternalActionLedger<TicketTransitionRef>(),
      integrationLedger: createExternalActionLedger<IntegrationStepRef>(),
    },
  }
}

const failing = (summary: string): ReviewProposal => ({
  verdict: 'fail',
  findings: [{ severity: 'blocker', summary }],
})

describe('runAutonomousWorkflow', () => {
  it('develops, opens a draft pull request, reviews, and integrates on a pass (FR-061)', async () => {
    const world = await harness({
      verdicts: [{ verdict: 'pass' }],
      integrationSteps: [{ entryId: 'entry-a', name: 'promote' }],
    })

    const result = await runAutonomousWorkflow(world.input)

    expect(result.outcome).toBe('succeeded')
    expect(result.iterations).toHaveLength(1)
    expect(result.iterations[0]?.pullRequests.members[0]?.pullRequest?.isDraft).toBe(true)
    expect(world.integrated).toEqual(['entry-a/promote'])
    expect(world.recorded.map((record) => record.verdict)).toEqual(['pass'])
  })

  it('feeds each review’s findings into the next development pass', async () => {
    const world = await harness({ verdicts: [failing('Unbounded retry.'), { verdict: 'pass' }] })
    const feedback: string[][] = []

    const result = await runAutonomousWorkflow({
      ...world.input,
      developer: async (request) => {
        feedback.push(request.feedback.map((finding) => finding.summary))
        return Promise.resolve(proposal())
      },
    })

    expect(feedback).toEqual([[], ['Unbounded retry.']])
    expect(result.outcome).toBe('succeeded')
    expect(result.iterations).toHaveLength(2)
  })

  it('stops at three with the history intact rather than trying a fourth time (FR-062)', async () => {
    const world = await harness({
      verdicts: [failing('One.'), failing('Two.'), failing('Three.')],
    })

    const result = await runAutonomousWorkflow(world.input)

    expect(result.outcome).toBe('needs_attention')
    expect(result.iterations).toHaveLength(3)
    expect(result.history.map((pass) => pass.ordinal)).toEqual([1, 2, 3])
    expect(world.recorded).toHaveLength(3)
    expect(result.exhaustion?.unresolved.map((finding) => finding.summary)).toEqual([
      'One.',
      'Two.',
      'Three.',
    ])
    expect(result.exhaustion?.stoppedWithoutRetrying).toBe(true)
  })

  it('never asks the platform to record a fourth pass', async () => {
    const world = await harness({
      verdicts: [failing('One.'), failing('Two.'), failing('Three.'), failing('Four.')],
    })

    await runAutonomousWorkflow(world.input)

    expect(world.recorded.map((record) => record.ordinal)).toEqual([1, 2, 3])
  })

  it('moves the ticket only where a skill named a state, and never otherwise', async () => {
    const silent = await harness({ verdicts: [{ verdict: 'pass' }] })

    await runAutonomousWorkflow(silent.input)

    expect(silent.ticketMoves).toEqual([])

    const prescribed = await harness({
      verdicts: [
        {
          verdict: 'pass',
          ticketInstruction: 'A passing review moves it along the board.',
          ticketState: 'Ready to Ship',
        },
      ],
      development: {
        ticketInstruction: 'Once the draft is open, it waits for review.',
        ticketState: 'Awaiting Review',
      },
    })

    await runAutonomousWorkflow(prescribed.input)

    expect(prescribed.ticketMoves).toEqual(['Awaiting Review', 'Ready to Ship'])
  })

  it('stops at a completed pass when a cap is reached, not mid-turn (FR-055)', async () => {
    const world = await harness({
      verdicts: [failing('One.')],
      turnCap: 5,
      usage: () => ({ turns: 9, spendUsd: 0 }),
    })

    const result = await runAutonomousWorkflow(world.input)

    expect(result.outcome).toBe('capped')
    expect(result.iterations).toHaveLength(1)
    expect(result.history).toHaveLength(1)
    expect(result.reason).toContain('turn')
  })

  it('halts before touching anything when the primary entry has no sisyphus-dev (FR-058)', async () => {
    const world = await harness({
      verdicts: [{ verdict: 'pass' }],
      source: await skillSource({
        'sisyphus-review': 'A rubric with no development skill beside it.',
      }),
    })

    await expect(runAutonomousWorkflow(world.input)).rejects.toThrow(
      /sisyphus-dev skill is missing/iu,
    )
    expect(world.ticketMoves).toEqual([])
  })

  it('reads the integration order once, before the set is opened, and reuses it (FR-116, FR-117)', async () => {
    let plannerCalls = 0
    const world = await harness({
      verdicts: [{ verdict: 'pass' }],
      entries: [entry('entry-a', 'git.test/api'), entry('entry-b', 'git.test/client')],
      order: ['entry-a', 'entry-b'],
      integrationSteps: [
        { entryId: 'entry-b', name: 'promote' },
        { entryId: 'entry-a', name: 'promote' },
      ],
    })

    const result = await runAutonomousWorkflow({
      ...world.input,
      planner: async (skill) => {
        plannerCalls += 1
        expect(skill.skillName).toBe('sisyphus-integration')
        return Promise.resolve({
          order: { entryIds: ['entry-a', 'entry-b'] },
          steps: [
            { entryId: 'entry-b', name: 'promote', instruction: 'Second.' },
            { entryId: 'entry-a', name: 'promote', instruction: 'First.' },
          ],
        })
      },
    })

    expect(plannerCalls).toBe(1)
    expect(world.integrated).toEqual(['entry-a/promote', 'entry-b/promote'])
    expect(result.iterations[0]?.pullRequests.members).toHaveLength(2)
  })

  it('does not read sisyphus-integration at all for a single-repository run until it needs to', async () => {
    const world = await harness({
      verdicts: [failing('One.'), failing('Two.'), failing('Three.')],
      source: await skillSource({
        'sisyphus-dev': 'Branch from whatever this repository calls its integration line.',
        'sisyphus-review': 'Block untested behaviour.',
      }),
    })

    const result = await runAutonomousWorkflow(world.input)

    // Three failing passes never reach the integrate step, and the missing skill never halts it.
    expect(result.outcome).toBe('needs_attention')
  })

  it('reports a partial integration as needing attention rather than success (FR-118)', async () => {
    const world = await harness({
      verdicts: [{ verdict: 'pass' }],
      integrationSteps: [
        { entryId: 'entry-a', name: 'promote' },
        { entryId: 'entry-a', name: 'deploy' },
      ],
    })

    const result = await runAutonomousWorkflow({
      ...world.input,
      integrator: async ({ entryId, name }) =>
        name === 'deploy'
          ? Promise.reject(new Error('the deploy was rejected'))
          : Promise.resolve({ entryId, name, reference: 'ref-1' }),
    })

    expect(result.outcome).toBe('needs_attention')
    expect(result.integration?.isPartial).toBe(true)
    expect(result.reason).toContain('partial integration')
  })
})

/**
 * The same loop against a genuine child process speaking the agent protocol.
 *
 * The stub is not the CLI and this does not pretend otherwise — its scheduling is its own. What it
 * genuinely proves is that the loop can drive an agent that is a **process**: turns are delivered
 * over a real pipe, turn boundaries are reached, consumption accumulates on the adapter, and the
 * loop's cap check reads figures a process produced rather than figures a test made up. All of it
 * for no inference cost.
 */
describe('the loop against the stub agent process', () => {
  const SESSION_ID = '9f1d1b3e-0000-4000-8000-000000000abc'

  const stubProcessSpec: AgentProcessSpecFactory = () => ({
    command: resolveTsxBinary(),
    args: [
      stubAgentEntry(),
      JSON.stringify({
        sessionId: SESSION_ID,
        chunkCount: 2,
        chunkDelayMs: 1,
        spendPerTurnUsd: 0.05,
      }),
    ],
    env: {},
  })

  const startAdapter = async (): Promise<{
    readonly adapter: AgentAdapter
    readonly dispose: () => Promise<void>
  }> => {
    const adapter = createCliStreamAdapter({
      processSpec: stubProcessSpec,
      onUnknownFrame: () => undefined,
      quiesceTimeoutMs: 20_000,
      sendTurnTimeoutMs: 10_000,
    })

    const frames: AgentFrame[] = []
    const consumed = (async (): Promise<void> => {
      for await (const frame of adapter.output) {
        frames.push(frame)
      }
    })()

    await adapter.start({
      sessionId: SESSION_ID,
      cwd: process.cwd(),
      model: 'stub',
      prompt: 'Follow the resolved skills.',
    })
    await adapter.quiesce()

    return {
      adapter,
      dispose: async () => {
        await adapter.stop({ force: true })
        await consumed
      },
    }
  }

  it('runs three iterations over real pipes and stops at needs_attention', async () => {
    const { adapter, dispose } = await startAdapter()

    try {
      const world = await harness({
        verdicts: [failing('One.'), failing('Two.'), failing('Three.')],
      })

      // Each port drives the process for a turn, then stands in for the parsing a real port does.
      const drive = async (body: string): Promise<void> => {
        await adapter.sendTurn(body)
        await adapter.quiesce()
      }

      const result = await runAutonomousWorkflow({
        ...world.input,
        developer: async (request) => {
          await drive(request.skill.body)
          return proposal()
        },
        reviewer: async (request) => {
          await drive(request.skill.body)
          const call = world.recorded.length
          return call >= 2 ? failing('Three.') : call === 1 ? failing('Two.') : failing('One.')
        },
        usage: () => adapter.usage,
      })

      expect(result.outcome).toBe('needs_attention')
      expect(result.history).toHaveLength(3)
      // Six turns were delivered to a real process — one per develop and one per review.
      expect(adapter.usage.turns).toBeGreaterThanOrEqual(6)
      expect(adapter.usage.spendUsd).toBeGreaterThan(0)
    } finally {
      await dispose()
    }
  }, 60_000)
})
