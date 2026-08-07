import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { AgentUsage } from '../agent'
import { createCapEnforcer } from '../caps'
import type {
  ExternalActionLedger,
  Forge,
  GitReader,
  PullRequestDelivery,
  PullRequestSetEntry,
} from '../delivery'
import { createExternalActionLedger } from '../delivery'
import type { SkillSource } from '../skills'
import type {
  DevelopmentProposal,
  IntegrationStepRef,
  ReviewCommentRef,
  ReviewGuard,
  TicketTransitionRef,
} from '../workflows'

import { dispatchWorkflow } from './dispatch'
import type { WorkflowDispatchInput } from './dispatch'

/**
 * The one place that chooses a workflow type (T178, FR-064).
 *
 * The three workflows have their own end-to-end suites; what is under test here is the selection
 * and the refusal — that `job.workflowType` reaches the right orchestrator, that each answers with
 * an FR-064 outcome, and that an assembly missing a type's ports halts naming the type rather than
 * running something else.
 */

const WORKFLOW_ID = '019fd631-15bf-7a03-a1c6-ff6d568c2654'
const HEAD = 'c'.repeat(40)

const skillSource = async (): Promise<SkillSource> => {
  const root = await mkdtemp(join(tmpdir(), 'sisyphus-dispatch-'))

  for (const [name, body] of Object.entries({
    'sisyphus-dev': 'Branch from whatever this repository calls its integration line.',
    'sisyphus-review': 'Block anything that changes behaviour without a test beside it.',
    'sisyphus-integration': 'Land it however this repository lands things.',
  })) {
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
  let next = 300

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

const entries = (): readonly PullRequestSetEntry[] => [
  {
    entryId: 'entry-a',
    repository: 'git.test/app',
    baseBranch: 'integration-line',
    wasChanged: true,
    git: fakeGit,
    forge: fakeForge(),
  },
]

const proposal = (): DevelopmentProposal => ({
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
})

const openGuard: ReviewGuard = {
  checkpoint: async () => Promise.resolve({ action: 'continue', observed: [] }),
}

const common = async (): Promise<Omit<WorkflowDispatchInput, 'workflowType'>> => ({
  workflowId: WORKFLOW_ID,
  source: await skillSource(),
  report: () => undefined,
  caps: createCapEnforcer({ spendCapsEnforceable: true }),
  usage: (): AgentUsage => ({ turns: 0, spendUsd: 0 }),
})

const delegatedPorts = (): NonNullable<WorkflowDispatchInput['delegated']> => ({
  developer: async () => Promise.resolve(proposal()),
  entries: entries(),
  pullRequestLedger: createExternalActionLedger<PullRequestDelivery>(),
})

const autonomousPorts = (): NonNullable<WorkflowDispatchInput['autonomous']> => ({
  developer: async () => Promise.resolve(proposal()),
  reviewer: async () => Promise.resolve({ verdict: 'pass' as const }),
  planner: async () => Promise.resolve({ steps: [] }),
  integrator: async ({ entryId, name }) => Promise.resolve({ entryId, name, reference: 'ref-1' }),
  entries: entries(),
  recordIteration: async () => Promise.resolve(),
  ticketLedger: createExternalActionLedger<TicketTransitionRef>(),
  integrationLedger: createExternalActionLedger<IntegrationStepRef>(),
})

const reviewPorts = (
  posted: string[],
): {
  readonly ports: NonNullable<WorkflowDispatchInput['review']>
  readonly ledger: ExternalActionLedger<ReviewCommentRef>
} => {
  const ledger = createExternalActionLedger<ReviewCommentRef>()

  return {
    ledger,
    ports: {
      reviewer: async () =>
        Promise.resolve({ verdict: 'pass' as const, comment: 'Nothing blocking.' }),
      guard: openGuard,
      targets: [
        {
          entryId: 'entry-a',
          repository: 'git.test/app',
          pullRequestNumber: 42,
          pullRequestUrl: 'https://git.test/app/pull/42',
        },
      ],
      publisher: async (input) => {
        posted.push(input.repository)

        return Promise.resolve({
          repository: input.repository,
          pullRequestNumber: input.pullRequestNumber,
          commentId: 'comment-1',
          url: 'https://git.test/c/1',
        })
      },
      commentLedger: ledger,
    },
  }
}

describe('dispatchWorkflow', () => {
  it('runs the delegated orchestrator for a delegated job (US1)', async () => {
    const result = await dispatchWorkflow({
      ...(await common()),
      workflowType: 'delegated',
      delegated: delegatedPorts(),
    })

    expect(result.workflowType).toBe('delegated')
    expect(result.outcome).toBe('succeeded')
    expect(result.delegated?.movedTicket).toBe(false)
    expect(result.autonomous).toBeUndefined()
    expect(result.review).toBeUndefined()
  })

  it('runs the autonomous loop for an autonomous job (FR-061)', async () => {
    const result = await dispatchWorkflow({
      ...(await common()),
      workflowType: 'autonomous',
      autonomous: autonomousPorts(),
    })

    expect(result.workflowType).toBe('autonomous')
    expect(result.outcome).toBe('succeeded')
    expect(result.autonomous?.iterations).toHaveLength(1)
    expect(result.delegated).toBeUndefined()
  })

  it('runs the review workflow for a review job, changing no code (FR-063)', async () => {
    const posted: string[] = []
    const result = await dispatchWorkflow({
      ...(await common()),
      workflowType: 'review',
      review: reviewPorts(posted).ports,
    })

    expect(result.workflowType).toBe('review')
    expect(result.outcome).toBe('succeeded')
    expect(result.review?.madeCodeChanges).toBe(false)
    expect(posted).toStrictEqual(['git.test/app'])
  })

  it('hands each type only its own ports, so the guarantees stay structural', async () => {
    const context = await common()

    // Every type's ports are available, and the delegated run still cannot move a ticket: there is
    // no ticket port on its input for the dispatcher to pass one through.
    const result = await dispatchWorkflow({
      ...context,
      workflowType: 'delegated',
      delegated: delegatedPorts(),
      autonomous: autonomousPorts(),
      review: reviewPorts([]).ports,
    })

    expect(result.delegated?.movedTicket).toBe(false)
    expect(result.autonomous).toBeUndefined()
  })

  it('halts naming the type when this assembly has no ports for it', async () => {
    for (const workflowType of ['delegated', 'autonomous', 'review'] as const) {
      await expect(dispatchWorkflow({ ...(await common()), workflowType })).rejects.toThrow(
        new RegExp(`${workflowType} workflow`, 'u'),
      )
    }
  })

  it('substitutes no other workflow type for one it cannot run', async () => {
    const attempted: string[] = []

    await dispatchWorkflow({
      ...(await common()),
      workflowType: 'review',
      delegated: {
        ...delegatedPorts(),
        developer: async () => {
          attempted.push('developer')

          return Promise.resolve(proposal())
        },
      },
      review: reviewPorts([]).ports,
    })

    expect(attempted).toStrictEqual([])
  })
})
