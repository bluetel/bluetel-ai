import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { AgentUsage } from '../agent'
import { createCapEnforcer } from '../caps'
import type { Forge, GitReader, PullRequestDelivery, PullRequestSetEntry } from '../delivery'
import { createExternalActionLedger } from '../delivery'
import type { SkillSource } from '../skills'

import { runDelegatedWorkflow } from './delegated'
import type { DelegatedWorkflowInput } from './delegated'
import type { DevelopmentProposal } from './develop-step'

/**
 * The delegated run, end to end (US1, FR-060, FR-064, FR-115, FR-117, FR-118).
 *
 * No network, no git process, no paid inference: the two forge-facing ports are fakes, because
 * what is under test is the composition rather than the verification `src/delivery` already owns.
 *
 * The assertions that matter most are the negative ones. A delegated run that quietly moved a
 * ticket or opened a pull request ready for review would pass every other test in this file, and
 * both are the failures a customer sees rather than a maintainer.
 */

const WORKFLOW_ID = '019fd631-15bf-7a03-a1c6-ff6d568c2654'
const HEAD = 'b'.repeat(40)

const skillSource = async (
  skills: Readonly<Record<string, string>> = {
    'sisyphus-dev': 'Branch from whatever this repository calls its integration line.',
    'sisyphus-integration': 'Land it however this repository lands things.',
  },
): Promise<SkillSource> => {
  const root = await mkdtemp(join(tmpdir(), 'sisyphus-delegated-'))

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
  let next = 200

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

const refusingForge = (): Forge => ({
  branchHead: async () => Promise.resolve(HEAD),
  findPullRequest: async () => Promise.resolve(undefined),
  createPullRequest: async () => Promise.reject(new Error('the forge said no')),
})

const entry = (
  entryId: string,
  repository: string,
  overrides: Partial<PullRequestSetEntry> = {},
): PullRequestSetEntry => ({
  entryId,
  repository,
  baseBranch: 'integration-line',
  wasChanged: true,
  git: fakeGit,
  forge: fakeForge(),
  ...overrides,
})

const proposal = (overrides: Partial<DevelopmentProposal> = {}): DevelopmentProposal => ({
  conventions: {
    remote: 'origin',
    branchName: 'ticket-1234-changelog-entry',
    baseBranch: 'integration-line',
    pullRequestTitle: 'ABC-1234 Add a changelog entry',
  },
  summary: {
    entries: [{ repository: 'git.test/app', changed: true, description: 'Added the entry.' }],
    decisions: [],
    assumptions: [],
    notDone: [],
    uncertainties: [],
  },
  ...overrides,
})

const harness = async (
  options: {
    readonly entries?: readonly PullRequestSetEntry[]
    readonly development?: Partial<DevelopmentProposal>
    readonly usage?: () => AgentUsage
    readonly turnCap?: number
    readonly order?: readonly string[]
    readonly withPlanner?: boolean
    readonly readyForReview?: boolean
    readonly source?: SkillSource
  } = {},
): Promise<DelegatedWorkflowInput> => ({
  workflowId: WORKFLOW_ID,
  source: options.source ?? (await skillSource()),
  report: () => undefined,
  developer: async () => Promise.resolve(proposal(options.development ?? {})),
  entries: options.entries ?? [entry('entry-a', 'git.test/app')],
  ...(options.withPlanner === false
    ? {}
    : {
        planner: async () =>
          Promise.resolve({
            ...(options.order === undefined ? {} : { order: { entryIds: options.order } }),
            steps: [],
          }),
      }),
  caps: createCapEnforcer({
    spendCapsEnforceable: true,
    ...(options.turnCap === undefined ? {} : { turnCap: options.turnCap }),
  }),
  usage: options.usage ?? ((): AgentUsage => ({ turns: 0, spendUsd: 0 })),
  pullRequestLedger: createExternalActionLedger<PullRequestDelivery>(),
  ...(options.readyForReview === undefined ? {} : { readyForReview: options.readyForReview }),
})

describe('runDelegatedWorkflow', () => {
  it('develops once and proposes a draft pull request (US1, FR-060)', async () => {
    const result = await runDelegatedWorkflow(await harness())

    expect(result.outcome).toBe('succeeded')
    expect(result.development.ordinal).toBe(1)
    expect(result.pullRequests.members).toHaveLength(1)
    expect(result.pullRequests.members[0]?.outcome).toBe('opened')
    expect(result.pullRequests.members[0]?.pullRequest?.isDraft).toBe(true)
    expect(result.movedTicket).toBe(false)
  })

  it('opens the pull request ready for review only when the request said so (FR-060)', async () => {
    const result = await runDelegatedWorkflow(await harness({ readyForReview: true }))

    expect(result.pullRequests.members[0]?.pullRequest?.isDraft).toBe(false)
  })

  it('asks the developer for exactly one pass, with no feedback to carry', async () => {
    const requests: number[] = []
    const input = await harness()

    await runDelegatedWorkflow({
      ...input,
      developer: async (request) => {
        requests.push(request.feedback.length)
        return Promise.resolve(proposal())
      },
    })

    expect(requests).toEqual([0])
  })

  it('never resolves sisyphus-review, because a delegated run has no reviewer', async () => {
    const asked: string[] = []
    const input = await harness()

    await runDelegatedWorkflow({
      ...input,
      report: (report) => {
        asked.push(report.skillName)
      },
    })

    expect(asked).toEqual(['sisyphus-dev'])
  })

  it('proposes nothing for an entry the agent did not change (FR-115)', async () => {
    const input = await harness({
      entries: [
        entry('entry-a', 'git.test/app'),
        entry('entry-b', 'git.test/lib', { wasChanged: false }),
      ],
      order: ['entry-a', 'entry-b'],
    })

    const result = await runDelegatedWorkflow(input)

    expect(result.outcome).toBe('succeeded')
    expect(result.pullRequests.members.map((member) => member.outcome)).toEqual([
      'opened',
      'unchanged',
    ])
  })

  it('reaches needs_attention rather than success when the set is partial (FR-118)', async () => {
    const input = await harness({
      entries: [
        entry('entry-a', 'git.test/app'),
        entry('entry-b', 'git.test/lib', { forge: refusingForge() }),
      ],
      order: ['entry-a', 'entry-b'],
    })

    const result = await runDelegatedWorkflow(input)

    expect(result.outcome).toBe('needs_attention')
    expect(result.pullRequests.isPartial).toBe(true)
    expect(result.reason).toContain('git.test/lib')
    expect(result.reason).toContain('the forge said no')
  })

  it('halts rather than ordering a multi-repository set the skill did not order (FR-117)', async () => {
    const input = await harness({
      entries: [entry('entry-a', 'git.test/app'), entry('entry-b', 'git.test/lib')],
      withPlanner: false,
    })

    await expect(runDelegatedWorkflow(input)).rejects.toThrow(/integration order/iu)
  })

  it('reads sisyphus-integration only for the order, and only when there is one to read', async () => {
    const single = await harness()
    const singleSkills: string[] = []

    await runDelegatedWorkflow({
      ...single,
      report: (report) => {
        singleSkills.push(report.skillName)
      },
    })

    expect(singleSkills).not.toContain('sisyphus-integration')

    const multiple = await harness({
      entries: [entry('entry-a', 'git.test/app'), entry('entry-b', 'git.test/lib')],
      order: ['entry-a', 'entry-b'],
    })
    const multipleSkills: string[] = []

    await runDelegatedWorkflow({
      ...multiple,
      report: (report) => {
        multipleSkills.push(report.skillName)
      },
    })

    expect(multipleSkills).toContain('sisyphus-integration')
  })

  it('reports capped when the pass exhausted the turn cap (FR-055)', async () => {
    const input = await harness({
      turnCap: 5,
      usage: (): AgentUsage => ({ turns: 6, spendUsd: 0 }),
    })

    const result = await runDelegatedWorkflow(input)

    expect(result.outcome).toBe('capped')
    expect(result.reason).toContain('turn')
    // The work still landed: a cap stops the run, it does not unmake a pull request.
    expect(result.pullRequests.members[0]?.outcome).toBe('opened')
  })

  it('prefers needs_attention over capped when delivery is what needs a person', async () => {
    const input = await harness({
      entries: [entry('entry-b', 'git.test/lib', { forge: refusingForge() })],
      turnCap: 5,
      usage: (): AgentUsage => ({ turns: 6, spendUsd: 0 }),
    })

    const result = await runDelegatedWorkflow(input)

    expect(result.outcome).toBe('needs_attention')
  })

  it('halts naming the skill when sisyphus-dev came back incomplete (FR-058)', async () => {
    const input = await harness({ development: { conventions: { remote: 'origin' } } })

    await expect(runDelegatedWorkflow(input)).rejects.toThrow(/sisyphus-dev/u)
  })

  it('replays an already-opened pull request rather than opening a second (FR-076)', async () => {
    const ledger = createExternalActionLedger<PullRequestDelivery>()
    const input = { ...(await harness()), pullRequestLedger: ledger }

    const first = await runDelegatedWorkflow(input)
    const second = await runDelegatedWorkflow(input)

    expect(second.pullRequests.members[0]?.pullRequest?.number).toBe(
      first.pullRequests.members[0]?.pullRequest?.number,
    )
    expect(second.pullRequests.members[0]?.alreadyExisted).toBe(true)
  })
})
