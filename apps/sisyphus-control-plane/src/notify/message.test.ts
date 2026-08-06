import { describe, expect, it } from 'vitest'

import {
  composeTickSummaryMessage,
  composeWorkflowMessage,
  TICK_SUMMARY_LINK_LIMIT,
  workflowDetailUrl,
} from './message'
import { fakeSubject } from './notification-store-fake'

/**
 * FR-137 names six things a notification must state, plus a direct link. Each is asserted
 * individually, so "the message quietly lost the ticket reference" is a failing test rather than
 * something somebody notices in Slack a fortnight later.
 */

const panel = { baseUrl: 'https://sisyphus.example.com' }

describe('composeWorkflowMessage (FR-137)', () => {
  const subject = fakeSubject({
    workflowId: 'w1',
    state: 'needs_attention',
    ticketReference: 'PAY-42',
    workspaceName: 'Payments',
    outcomeReason: 'The agent asked a question.',
    turnsUsed: 12,
    turnCap: 40,
    spendUsed: '7.2500',
    spendCap: '25.0000',
  })

  const message = composeWorkflowMessage({
    subject,
    event: 'workflow_needs_attention',
    panel,
  })

  it('states the ticket, the workspace, the state and the reason', () => {
    expect(message).toContain('PAY-42')
    expect(message).toContain('Payments')
    expect(message).toContain('needs_attention')
    expect(message).toContain('The agent asked a question.')
  })

  it('states consumption to date against the caps', () => {
    expect(message).toContain('12 of 40 turns')
    expect(message).toContain('7.2500 of 25.0000 spent')
  })

  it('links directly to the workflow detail view', () => {
    expect(message).toContain('https://sisyphus.example.com/workflows/w1')
  })

  it('says so when it stands for several changes (FR-139)', () => {
    const coalesced = composeWorkflowMessage({
      subject,
      event: 'workflow_succeeded',
      panel,
      coalescedCount: 4,
    })

    // Without this line a coalesced message reads as though the platform dropped the others.
    expect(coalesced).toContain('4 changes')
    expect(message).not.toContain('changes in the last few minutes')
  })

  it('names the absences rather than printing undefined at a person', () => {
    const bare = composeWorkflowMessage({
      subject: fakeSubject({
        workflowId: 'w2',
        ticketReference: null,
        workspaceName: null,
        outcomeReason: null,
        turnCap: null,
        spendCap: null,
      }),
      event: 'workflow_failed',
      panel,
    })

    expect(bare).toContain('no ticket')
    expect(bare).toContain('ad hoc workspace')
    expect(bare).toContain('none recorded')
    expect(bare).not.toContain('undefined')
    expect(bare).not.toContain('null')
  })

  it('covers every event with wording of its own', () => {
    const events = [
      'workflow_succeeded',
      'workflow_failed',
      'workflow_capped',
      'workflow_cancelled',
      'workflow_needs_attention',
      'workflow_parked_resumable',
      'review_iteration_failed',
    ] as const

    const headlines = events.map(
      (event) => composeWorkflowMessage({ subject, event, panel }).split('\n')[0],
    )

    expect(new Set(headlines).size).toBe(events.length)
  })
})

describe('workflowDetailUrl', () => {
  it('does not double the slash when the base URL has a trailing one', () => {
    expect(workflowDetailUrl({ baseUrl: 'https://sisyphus.example.com/' }, 'w1')).toBe(
      'https://sisyphus.example.com/workflows/w1',
    )
  })
})

describe('composeTickSummaryMessage (FR-139)', () => {
  it('counts the runs and names the integration', () => {
    const summary = composeTickSummaryMessage({
      integrationName: 'Acme board',
      workflowIds: ['w1', 'w2', 'w3'],
      panel,
    })

    expect(summary).toContain('Acme board started 3 runs')
    expect(summary).toContain('/workflows/w1')
    expect(summary).toContain('/workflows/w3')
  })

  it('stops listing links after a handful and counts the rest', () => {
    const workflowIds = Array.from(
      { length: TICK_SUMMARY_LINK_LIMIT + 3 },
      (_u, i) => `w${String(i)}`,
    )

    const summary = composeTickSummaryMessage({ integrationName: null, workflowIds, panel })

    expect(summary.split('\n').filter((line) => line.includes('/workflows/'))).toHaveLength(
      TICK_SUMMARY_LINK_LIMIT,
    )
    expect(summary).toContain('and 3 more')
  })

  it('has wording for an integration whose name did not resolve', () => {
    const summary = composeTickSummaryMessage({
      integrationName: null,
      workflowIds: ['w1', 'w2'],
      panel,
    })

    expect(summary).toContain('An integration started 2 runs')
  })
})
