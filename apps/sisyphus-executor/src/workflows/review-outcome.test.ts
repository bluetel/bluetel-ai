import { describe, expect, it } from 'vitest'

import { createExternalActionLedger } from '../delivery'
import type { ResolvedSkill } from '../skills'

import type { ReviewGuard, ReviewTargetState } from './review-guard'
import { createReviewGuard, openTargetGuard } from './review-guard'
import type { FindingsPublisher, ReviewCommentRef } from './review-outcome'
import { applyReviewOutcome } from './review-outcome'
import type { ReviewAssessment, ReviewTarget } from './review-step'
import { directiveFrom } from './skill-directive'
import type { TicketPort, TicketTransitionRef } from './ticket'

/**
 * Acting on a verdict — the one place a ticket transition is correct, and only where the skill
 * says so (FR-057, FR-060, FR-063, FR-076, FR-080).
 */

const WORKFLOW_ID = '019fd631-15bf-7a03-a1c6-ff6d568c2654'
const TICKET = 'ABC-1234'

const skill = (): ResolvedSkill => ({
  skillName: 'sisyphus-review',
  entryId: 'entry-a',
  resolvedPath: '.claude/skills/sisyphus-review/SKILL.md',
  absolutePath: '/workspace/primary/.claude/skills/sisyphus-review/SKILL.md',
  contentDigest: 'd'.repeat(64),
  byteSize: 700,
  body: 'Post the findings, then move the ticket.',
})

const target: ReviewTarget = {
  entryId: 'entry-a',
  repository: 'git.test/app',
  pullRequestNumber: 7,
  pullRequestUrl: 'https://git.test/app/pull/7',
}

const assessment = (overrides: Partial<ReviewAssessment> = {}): ReviewAssessment => ({
  skill: skill(),
  verdict: 'pass',
  findings: [],
  targets: [target],
  comment: 'Nothing blocking.',
  directive: directiveFrom(skill(), { step: 'review', instruction: 'Verdict "pass".' }),
  ...overrides,
})

const publisherThatRecords = (): {
  readonly publisher: FindingsPublisher
  readonly posts: readonly { readonly body: string }[]
} => {
  const posts: { body: string }[] = []

  return {
    posts,
    publisher: async ({ repository, pullRequestNumber, body }) => {
      posts.push({ body })
      return Promise.resolve({
        repository,
        pullRequestNumber,
        url: `https://git.test/app/pull/${String(pullRequestNumber)}#c1`,
      })
    },
  }
}

const ticketThatRecords = (): {
  readonly port: TicketPort
  readonly moves: readonly string[]
} => {
  const moves: string[] = []

  return {
    moves,
    port: {
      transition: async ({ ticketReference, toState }) => {
        moves.push(toState)
        return Promise.resolve({ ticketReference, toState })
      },
    },
  }
}

const guardFor = (state: ReviewTargetState): ReviewGuard =>
  createReviewGuard({ targets: [target], probe: async () => Promise.resolve(state) })

describe('applyReviewOutcome', () => {
  it('posts the findings the skill composed', async () => {
    const publisher = publisherThatRecords()

    const record = await applyReviewOutcome({
      workflowId: WORKFLOW_ID,
      assessment: assessment(),
      guard: openTargetGuard([target]),
      publisher: publisher.publisher,
      commentLedger: createExternalActionLedger<ReviewCommentRef>(),
    })

    expect(publisher.posts.map((post) => post.body)).toEqual(['Nothing blocking.'])
    expect(record.posted).toHaveLength(1)
    expect(record.madeCodeChanges).toBe(false)
  })

  it('leaves the ticket where it is when the skill prescribes no move (FR-063)', async () => {
    const ticket = ticketThatRecords()

    const record = await applyReviewOutcome({
      workflowId: WORKFLOW_ID,
      assessment: assessment(),
      guard: openTargetGuard([target]),
      publisher: publisherThatRecords().publisher,
      commentLedger: createExternalActionLedger<ReviewCommentRef>(),
      ticketReference: TICKET,
      ticket: ticket.port,
    })

    expect(ticket.moves).toEqual([])
    expect(record.ticket).toMatchObject({ moved: false })
    expect('reason' in record.ticket ? record.ticket.reason : '').toContain(
      'prescribes no ticket transition',
    )
  })

  it('moves the ticket exactly where the skill named, and nowhere else', async () => {
    const ticket = ticketThatRecords()

    const record = await applyReviewOutcome({
      workflowId: WORKFLOW_ID,
      assessment: assessment({
        ticket: {
          toState: 'Ready to Ship',
          directive: directiveFrom(skill(), {
            step: 'review',
            instruction: 'A passing review moves it along.',
          }),
        },
      }),
      guard: openTargetGuard([target]),
      publisher: publisherThatRecords().publisher,
      commentLedger: createExternalActionLedger<ReviewCommentRef>(),
      ticketReference: TICKET,
      ticket: ticket.port,
      ticketLedger: createExternalActionLedger<TicketTransitionRef>(),
    })

    expect(ticket.moves).toEqual(['Ready to Ship'])
    expect('toState' in record.ticket ? record.ticket.toState : '').toBe('Ready to Ship')
  })

  it('posts before it moves, so a failed comment never strands a moved ticket', async () => {
    const order: string[] = []
    const ticket: TicketPort = {
      transition: async ({ ticketReference, toState }) => {
        order.push('ticket')
        return Promise.resolve({ ticketReference, toState })
      },
    }

    await applyReviewOutcome({
      workflowId: WORKFLOW_ID,
      assessment: assessment({
        ticket: {
          toState: 'Ready to Ship',
          directive: directiveFrom(skill(), { step: 'review', instruction: 'Move it.' }),
        },
      }),
      guard: openTargetGuard([target]),
      publisher: async ({ repository, pullRequestNumber }) => {
        order.push('comment')
        return Promise.resolve({ repository, pullRequestNumber, url: 'https://git.test/c' })
      },
      commentLedger: createExternalActionLedger<ReviewCommentRef>(),
      ticketReference: TICKET,
      ticket,
    })

    expect(order).toEqual(['comment', 'ticket'])
  })

  it('posts nothing and moves nothing when the target is already merged (FR-080)', async () => {
    const publisher = publisherThatRecords()
    const ticket = ticketThatRecords()

    const record = await applyReviewOutcome({
      workflowId: WORKFLOW_ID,
      assessment: assessment({
        ticket: {
          toState: 'Ready to Ship',
          directive: directiveFrom(skill(), { step: 'review', instruction: 'Move it.' }),
        },
      }),
      guard: guardFor('merged'),
      publisher: publisher.publisher,
      commentLedger: createExternalActionLedger<ReviewCommentRef>(),
      ticketReference: TICKET,
      ticket: ticket.port,
    })

    expect(publisher.posts).toEqual([])
    expect(ticket.moves).toEqual([])
    expect(record.noOp?.commentsPosted).toBe(0)
    expect(record.noOp?.ticketTransitioned).toBe(false)
  })

  it('does not post the same comment twice when the step is retried (FR-076)', async () => {
    const publisher = publisherThatRecords()
    const ledger = createExternalActionLedger<ReviewCommentRef>()
    const request = {
      workflowId: WORKFLOW_ID,
      assessment: assessment(),
      guard: openTargetGuard([target]),
      publisher: publisher.publisher,
      commentLedger: ledger,
    }

    await applyReviewOutcome(request)
    const replay = await applyReviewOutcome(request)

    expect(publisher.posts).toHaveLength(1)
    expect(replay.posted[0]?.disposition).toBe('replayed')
  })

  it('halts rather than half-performing when the skill wants a move and there is no connector', async () => {
    await expect(
      applyReviewOutcome({
        workflowId: WORKFLOW_ID,
        assessment: assessment({
          ticket: {
            toState: 'Ready to Ship',
            directive: directiveFrom(skill(), { step: 'review', instruction: 'Move it.' }),
          },
        }),
        guard: openTargetGuard([target]),
        publisher: publisherThatRecords().publisher,
        commentLedger: createExternalActionLedger<ReviewCommentRef>(),
        ticketReference: TICKET,
      }),
    ).rejects.toThrow(/no ticket connector/iu)
  })

  it('posts nothing at all when the skill composed no comment', async () => {
    const publisher = publisherThatRecords()

    const record = await applyReviewOutcome({
      workflowId: WORKFLOW_ID,
      assessment: { ...assessment(), comment: undefined },
      guard: openTargetGuard([target]),
      publisher: publisher.publisher,
      commentLedger: createExternalActionLedger<ReviewCommentRef>(),
    })

    expect(publisher.posts).toEqual([])
    expect(record.posted).toEqual([])
  })
})
