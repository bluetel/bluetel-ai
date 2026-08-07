import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { createExternalActionLedger } from '../delivery'
import type { SkillSource } from '../skills'

import { runReviewWorkflow } from './review'
import { createReviewGuard, openTargetGuard } from './review-guard'
import type { ReviewTargetState } from './review-guard'
import type { ReviewCommentRef } from './review-outcome'
import type { ReviewTarget } from './review-step'
import type { TicketPort, TicketTransitionRef } from './ticket'

/**
 * The review workflow type — evaluates, posts, records, moves only what the skill prescribes, and
 * changes no code (FR-063, FR-080, FR-119).
 */

const WORKFLOW_ID = '019fd631-15bf-7a03-a1c6-ff6d568c2654'
const RUBRIC = 'Block anything that changes behaviour without a test beside it.'

const here = dirname(fileURLToPath(import.meta.url))

const source = async (): Promise<SkillSource> => {
  const root = await mkdtemp(join(tmpdir(), 'sisyphus-review-workflow-'))
  const path = join(root, '.claude', 'skills', 'sisyphus-review', 'SKILL.md')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, RUBRIC, 'utf8')

  return { entryId: 'entry-a', path: root }
}

const target: ReviewTarget = {
  entryId: 'entry-a',
  repository: 'git.test/app',
  pullRequestNumber: 7,
  pullRequestUrl: 'https://git.test/app/pull/7',
}

const noopPublisher = async ({
  repository,
  pullRequestNumber,
}: {
  readonly repository: string
  readonly pullRequestNumber: number
}): Promise<ReviewCommentRef> =>
  Promise.resolve({ repository, pullRequestNumber, url: 'https://git.test/app/pull/7#c1' })

describe('runReviewWorkflow', () => {
  it('reviews, posts and records a verdict without changing any code', async () => {
    const result = await runReviewWorkflow({
      workflowId: WORKFLOW_ID,
      source: await source(),
      report: () => undefined,
      reviewer: async () => Promise.resolve({ verdict: 'pass', comment: 'Nothing blocking.' }),
      guard: openTargetGuard([target]),
      targets: [target],
      publisher: noopPublisher,
      commentLedger: createExternalActionLedger<ReviewCommentRef>(),
    })

    expect(result.outcome).toBe('succeeded')
    expect(result.madeCodeChanges).toBe(false)
    expect(result.assessment?.verdict).toBe('pass')
    expect(result.applied?.posted).toHaveLength(1)
    expect(result.reason).toContain('No code was changed')
  })

  it('exits with a no-op before reviewing anything when the target is already merged (FR-080)', async () => {
    let reviewed = false

    const result = await runReviewWorkflow({
      workflowId: WORKFLOW_ID,
      source: await source(),
      report: () => undefined,
      reviewer: async () => {
        reviewed = true
        return Promise.resolve({ verdict: 'pass' })
      },
      guard: createReviewGuard({
        targets: [target],
        probe: async (): Promise<ReviewTargetState> => Promise.resolve('merged'),
      }),
      targets: [target],
      publisher: noopPublisher,
      commentLedger: createExternalActionLedger<ReviewCommentRef>(),
    })

    expect(reviewed).toBe(false)
    expect(result.outcome).toBe('succeeded')
    expect(result.noOp?.checkpoint).toBe('start')
    expect(result.noOp?.commentsPosted).toBe(0)
    expect(result.noOp?.ticketTransitioned).toBe(false)
    expect(result.assessment).toBeUndefined()
  })

  it('moves the ticket exactly once, and only because the skill said to', async () => {
    const moves: string[] = []
    const ticket: TicketPort = {
      transition: async ({ ticketReference, toState }) => {
        moves.push(toState)
        return Promise.resolve({ ticketReference, toState })
      },
    }

    await runReviewWorkflow({
      workflowId: WORKFLOW_ID,
      source: await source(),
      report: () => undefined,
      reviewer: async () =>
        Promise.resolve({
          verdict: 'pass',
          comment: 'Nothing blocking.',
          ticketInstruction: 'A passing review moves it along the board.',
          ticketState: 'Ready to Ship',
        }),
      guard: openTargetGuard([target]),
      targets: [target],
      publisher: noopPublisher,
      commentLedger: createExternalActionLedger<ReviewCommentRef>(),
      ticketReference: 'ABC-1234',
      ticket,
      ticketLedger: createExternalActionLedger<TicketTransitionRef>(),
    })

    expect(moves).toEqual(['Ready to Ship'])
  })

  it('evaluates a multi-entry run as one set and says so (FR-119)', async () => {
    const second: ReviewTarget = {
      entryId: 'entry-b',
      repository: 'git.test/client',
      pullRequestNumber: 4,
      pullRequestUrl: 'https://git.test/client/pull/4',
    }

    const result = await runReviewWorkflow({
      workflowId: WORKFLOW_ID,
      source: await source(),
      report: () => undefined,
      reviewer: async () =>
        Promise.resolve({
          verdict: 'fail',
          comment: 'The pair does not hold together.',
          findings: [
            { workflowEntryId: 'entry-b', severity: 'blocker', summary: 'Field never sent.' },
          ],
        }),
      guard: openTargetGuard([target, second]),
      targets: [target, second],
      publisher: noopPublisher,
      commentLedger: createExternalActionLedger<ReviewCommentRef>(),
    })

    expect(result.assessment?.targetCount).toBe(2)
    expect(result.reason).toContain('all 2 pull requests together')
    expect(result.applied?.posted).toHaveLength(2)
  })
})

describe('the review workflow’s shape (FR-063)', () => {
  it('has no argument through which code could be changed', () => {
    const source = readFileSync(join(here, 'review.ts'), 'utf8')
    const input = /export interface RunReviewWorkflowInput \{(?<body>[\s\S]*?)\n\}/u.exec(source)

    expect(input?.groups?.body).toBeDefined()

    for (const forbidden of [
      'developer',
      'GitReader',
      'GitRunner',
      'openPullRequestSet',
      'Forge',
    ]) {
      expect(input?.groups?.body ?? '').not.toContain(forbidden)
    }
  })
})
