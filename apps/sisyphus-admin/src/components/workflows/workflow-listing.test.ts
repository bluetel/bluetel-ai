import type { WorkflowState } from '@bluetel-ai/sisyphus-api/client'
import { describe, expect, it } from 'vitest'

import type { WorkflowListItem } from './workflow-listing'
import {
  ABSENT,
  abbreviateRunId,
  isLiveWorkflow,
  toWorkflowRowReadouts,
  workflowDuration,
  workflowStateReadout,
} from './workflow-listing'

/**
 * Row shaping — where a mistake would be invisible in markup and obvious in a table of inputs and
 * outputs.
 */

const LAUNCHED = new Date('2026-08-05T09:00:00.000Z')
const MOVED = new Date('2026-08-05T09:04:21.000Z')
const NOW = new Date('2026-08-05T09:10:00.000Z').getTime()

const item = (overrides: Partial<WorkflowListItem> = {}): WorkflowListItem =>
  ({
    id: '0199a1f4-0000-7000-8000-0000000000ab',
    type: 'delegated',
    state: 'succeeded',
    terminalOutcome: 'succeeded',
    ticketReference: 'ABC-12',
    model: 'claude-sonnet-4-5',
    turnsUsed: 14,
    spendUsed: '3.1400',
    createdAt: LAUNCHED,
    updatedAt: MOVED,
    initiatedByUserId: 'user-1',
    initiatedByDisplayName: 'Ada Lovelace',
    ownerUserId: 'user-1',
    ownerDisplayName: 'Ada Lovelace',
    originatingIntegrationId: null,
    originatingIntegrationName: null,
    executionProfileId: 'profile-1',
    executionProfileName: 'API maintenance',
    workspaceId: 'workspace-1',
    workspaceName: 'Acme platform',
    ...overrides,
  }) as WorkflowListItem

describe('isLiveWorkflow', () => {
  it('is true only for the states that may still hold compute', () => {
    const live: readonly WorkflowState[] = ['queued', 'provisioning', 'running', 'paused']
    const settled: readonly WorkflowState[] = [
      'succeeded',
      'failed',
      'capped',
      'cancelled',
      'parked_resumable',
      'needs_attention',
    ]

    expect(live.every(isLiveWorkflow)).toBe(true)
    expect(settled.some(isLiveWorkflow)).toBe(false)
  })
})

describe('abbreviateRunId', () => {
  it('marks the abbreviation, so a truncated id is never mistaken for a whole one', () => {
    expect(abbreviateRunId('0199a1f4-0000-7000-8000-0000000000ab')).toBe('0199a1f4…')
  })

  it('leaves a short id alone', () => {
    expect(abbreviateRunId('abc')).toBe('abc')
  })
})

describe('workflowDuration', () => {
  it('stops at the last movement for a settled run', () => {
    expect(workflowDuration(item(), NOW)).toBe('4:21')
  })

  it('runs to now for a live run, so the readout advances', () => {
    expect(workflowDuration(item({ state: 'running', terminalOutcome: null }), NOW)).toBe('10:00')
  })
})

describe('workflowStateReadout', () => {
  it('carries the elapsed time into the chip while a machine is working', () => {
    expect(workflowStateReadout(item({ state: 'running', terminalOutcome: null }), NOW)).toBe(
      'running 10:00',
    )
  })

  it('is the state alone once nothing is working', () => {
    expect(workflowStateReadout(item(), NOW)).toBe('succeeded')
  })

  it('reads an underscored state as words', () => {
    expect(
      workflowStateReadout(
        item({ state: 'needs_attention', terminalOutcome: 'needs_attention' }),
        NOW,
      ),
    ).toBe('needs attention')
  })
})

describe('toWorkflowRowReadouts', () => {
  it('carries every field FR-012 asks a row to show', () => {
    const row = toWorkflowRowReadouts(item(), NOW)

    expect(row).toMatchObject({
      startedByLabel: 'initiated by',
      startedBy: 'Ada Lovelace',
      owner: 'Ada Lovelace',
      type: 'delegated',
      workspace: 'Acme platform',
      ticket: 'ABC-12',
      model: 'claude-sonnet-4-5',
      executionProfile: 'API maintenance',
      startedAt: '2026-08-05 09:00',
      duration: '4:21',
      turns: '14',
      spend: '3.1400',
      outcome: 'succeeded',
    })
  })

  it('names the integration instead of a user when the run came from one', () => {
    const row = toWorkflowRowReadouts(
      item({
        initiatedByUserId: null,
        initiatedByDisplayName: null,
        originatingIntegrationId: 'integration-1',
        originatingIntegrationName: 'Acme Jira',
      }),
      NOW,
    )

    expect(row.startedByLabel).toBe('integration')
    expect(row.startedBy).toBe('Acme Jira')
  })

  it('says “platform” rather than nothing for a run with no human initiator and no integration', () => {
    const row = toWorkflowRowReadouts(
      item({ initiatedByUserId: null, initiatedByDisplayName: null }),
      NOW,
    )

    expect(row.startedBy).toBe('platform')
  })

  it('says a profile-less run is ad hoc, because that is a fact about how it started (FR-126)', () => {
    const row = toWorkflowRowReadouts(
      item({ executionProfileId: null, executionProfileName: null }),
      NOW,
    )

    expect(row.executionProfile).toBe('ad hoc')
  })

  it('renders an absent ticket and an unfinished outcome as a dash, not as an empty cell', () => {
    const row = toWorkflowRowReadouts(
      item({ ticketReference: null, state: 'running', terminalOutcome: null }),
      NOW,
    )

    expect(row.ticket).toBe(ABSENT)
    expect(row.outcome).toBe(ABSENT)
  })

  it('passes spend through exactly as the procedure returned it, never reformatted', () => {
    expect(toWorkflowRowReadouts(item({ spendUsed: '0.0500' }), NOW).spend).toBe('0.0500')
  })

  it('derives the chip’s colour input from the state and from nothing else (FR-025)', () => {
    expect(toWorkflowRowReadouts(item({ state: 'capped' }), NOW).state).toBe('capped')
  })
})
