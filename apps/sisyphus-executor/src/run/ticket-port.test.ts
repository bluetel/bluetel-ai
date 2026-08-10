/**
 * T196 — the ticket port that refuses, and why that is the implementation.
 *
 * There is nothing clever to assert here and that is the point: the test exists so that the day
 * somebody replaces this with a connector, the thing they have to delete is a test that says a
 * transition must never be reported as having happened when it did not.
 */

import { describe, expect, it } from 'vitest'

import { createExternalActionLedger } from '../delivery'
import type { SkillDirective, TicketTransitionRef } from '../workflows'
import { transitionTicket } from '../workflows'

import { createRefusingTicketPort } from './ticket-port'

const directive: SkillDirective = {
  skillName: 'sisyphus-review',
  entryId: '019fd631-15bf-7a03-a1c6-ff6d568c2660',
  step: 'review',
  contentDigest: 'ab12cd34'.repeat(8),
  resolvedPath: '.claude/skills/sisyphus-review/SKILL.md',
  instruction: 'move it on per the board',
}

describe('createRefusingTicketPort', () => {
  it('rejects every transition, naming what is absent', async () => {
    const port = createRefusingTicketPort()

    const error = await port
      .transition({ ticketReference: 'ACME-142', toState: 'In Review', idempotencyKey: 'k' })
      .catch((thrown: unknown) => thrown)

    expect(String(error)).toContain('ACME-142')
    expect(String(error)).toContain('In Review')
    expect(String(error)).toContain('no ticket connector')
    expect(String(error)).toContain('nothing was recorded as though it had been')
  })

  it('offers no `find`, because a connector that cannot move cannot answer either', () => {
    // A `find` returning `undefined` would report "the ticket is not there" about a system it never
    // asked, which `transitionTicket` would act on.
    expect(createRefusingTicketPort().find).toBeUndefined()
  })

  it('stops transitionTicket rather than letting it record a move', async () => {
    const record = transitionTicket({
      workflowId: '5b2e4c1a-0000-4000-8000-0000000004e2',
      ticketReference: 'ACME-142',
      toState: 'In Review',
      directive,
      ticket: createRefusingTicketPort(),
      ledger: createExternalActionLedger<TicketTransitionRef>(),
    })

    await expect(record).rejects.toThrow('no ticket connector')
  })
})
