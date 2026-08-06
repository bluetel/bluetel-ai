import { describe, expect, it } from 'vitest'

import { createExternalActionLedger } from '../delivery'
import type { ResolvedSkill } from '../skills'

import { directiveFrom } from './skill-directive'
import type { TicketPort, TicketTransitionRef } from './ticket'
import { ticketTransitionKey, ticketUntouched, transitionTicket } from './ticket'

/**
 * Moving a ticket — prescribed by a skill, performed at most once, and impossible without one
 * (FR-057, FR-060, FR-061, FR-063, FR-076).
 */

const WORKFLOW_ID = '019fd631-15bf-7a03-a1c6-ff6d568c2654'
const TICKET = 'ABC-1234'

const reviewSkill = (): ResolvedSkill => ({
  skillName: 'sisyphus-review',
  entryId: 'entry-1',
  resolvedPath: '.claude/skills/sisyphus-review/SKILL.md',
  absolutePath: '/workspace/primary/.claude/skills/sisyphus-review/SKILL.md',
  contentDigest: 'c'.repeat(64),
  byteSize: 900,
  body: 'On a passing review, move the ticket to whatever this board calls ready.',
})

interface Recorder {
  readonly port: TicketPort
  readonly moves: readonly { readonly toState: string; readonly idempotencyKey: string }[]
}

const recordingPort = (existing?: TicketTransitionRef): Recorder => {
  const moves: { toState: string; idempotencyKey: string }[] = []

  return {
    moves,
    port: {
      transition: async ({ ticketReference, toState, idempotencyKey }) => {
        moves.push({ toState, idempotencyKey })
        return Promise.resolve({ ticketReference, toState })
      },
      find: async () => Promise.resolve(existing),
    },
  }
}

const directive = (instruction = 'Move it to the board’s review column.') =>
  directiveFrom(reviewSkill(), { step: 'review', instruction })

describe('transitionTicket', () => {
  it('moves the ticket to the state the skill named, carrying the digest (FR-059)', async () => {
    const recorder = recordingPort()

    const record = await transitionTicket({
      workflowId: WORKFLOW_ID,
      ticketReference: TICKET,
      toState: 'Peer Review',
      directive: directive(),
      ticket: recorder.port,
      ledger: createExternalActionLedger<TicketTransitionRef>(),
    })

    expect(record.toState).toBe('Peer Review')
    expect(record.disposition).toBe('performed')
    expect(record.directive.contentDigest).toBe('c'.repeat(64))
    expect(recorder.moves).toHaveLength(1)
  })

  it('refuses to move anything no skill prescribed (FR-057)', async () => {
    const recorder = recordingPort()

    await expect(
      transitionTicket({
        workflowId: WORKFLOW_ID,
        ticketReference: TICKET,
        toState: 'Peer Review',
        directive: undefined,
        ticket: recorder.port,
        ledger: createExternalActionLedger<TicketTransitionRef>(),
      }),
    ).rejects.toThrow(/no skill prescribed it/iu)

    expect(recorder.moves).toEqual([])
  })

  it('refuses when the skill prescribed a move but named no column', async () => {
    const recorder = recordingPort()

    await expect(
      transitionTicket({
        workflowId: WORKFLOW_ID,
        ticketReference: TICKET,
        toState: '   ',
        directive: directive(),
        ticket: recorder.port,
        ledger: createExternalActionLedger<TicketTransitionRef>(),
      }),
    ).rejects.toThrow(/names no state to move it to/iu)

    expect(recorder.moves).toEqual([])
  })

  it('does not move the ticket twice when the report is retried (FR-076)', async () => {
    const recorder = recordingPort()
    const ledger = createExternalActionLedger<TicketTransitionRef>()
    const request = {
      workflowId: WORKFLOW_ID,
      ticketReference: TICKET,
      toState: 'Peer Review',
      directive: directive(),
      ticket: recorder.port,
      ledger,
    }

    await transitionTicket(request)
    const replay = await transitionTicket(request)

    expect(replay.disposition).toBe('replayed')
    expect(recorder.moves).toHaveLength(1)
  })

  it('still moves the ticket back on a later iteration — the target state is in the key', async () => {
    const recorder = recordingPort()
    const ledger = createExternalActionLedger<TicketTransitionRef>()
    const base = {
      workflowId: WORKFLOW_ID,
      ticketReference: TICKET,
      directive: directive(),
      ticket: recorder.port,
      ledger,
    }

    await transitionTicket({ ...base, toState: 'Peer Review' })
    await transitionTicket({ ...base, toState: 'In Flight' })

    expect(recorder.moves.map((move) => move.toState)).toEqual(['Peer Review', 'In Flight'])
  })

  it('accepts a move somebody else already made rather than repeating it', async () => {
    const recorder = recordingPort({ ticketReference: TICKET, toState: 'Peer Review' })

    const record = await transitionTicket({
      workflowId: WORKFLOW_ID,
      ticketReference: TICKET,
      toState: 'Peer Review',
      directive: directive(),
      ticket: recorder.port,
      ledger: createExternalActionLedger<TicketTransitionRef>(),
    })

    expect(record.disposition).toBe('already-performed')
    expect(recorder.moves).toEqual([])
  })
})

describe('ticketUntouched', () => {
  it('records a ticket left alone on purpose, which a missing field cannot (FR-060)', () => {
    const record = ticketUntouched(TICKET, 'This run is delegated; delivery stays with the author.')

    expect(record.moved).toBe(false)
    expect(record.ticketReference).toBe(TICKET)
    expect(record.reason).toContain('delegated')
  })
})

describe('ticketTransitionKey', () => {
  it('names the run, the ticket and the target state', () => {
    expect(
      ticketTransitionKey({
        workflowId: WORKFLOW_ID,
        ticketReference: TICKET,
        toState: 'Peer Review',
      }),
    ).toBe(`ticket-transition:${WORKFLOW_ID}:${TICKET}:Peer Review`)
  })
})
