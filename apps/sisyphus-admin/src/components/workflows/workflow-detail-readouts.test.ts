import { describe, expect, it } from 'vitest'

import type { ArtifactItem, TimelineItem, WorkflowDetailResult } from './workflow-detail-readouts'
import {
  toArtifactReadouts,
  toTimelineReadouts,
  toWorkflowDetailReadouts,
  toWorkflowEntryReadouts,
} from './workflow-detail-readouts'

/**
 * Detail shaping. The three decisions with a plausible wrong answer — an absent cap, a finished
 * run's duration, and an expired artifact — each have their own case here.
 */

const LAUNCHED = new Date('2026-08-05T09:00:00.000Z')
const MOVED = new Date('2026-08-05T09:04:21.000Z')
const NOW = new Date('2026-08-05T09:10:00.000Z').getTime()

const detail = (overrides: Record<string, unknown> = {}): WorkflowDetailResult =>
  ({
    workflow: {
      id: '0199a1f4-0000-7000-8000-0000000000ab',
      type: 'delegated',
      state: 'succeeded',
      terminalOutcome: 'succeeded',
      outcomeReason: 'The agent finished and opened a draft pull request.',
      ticketReference: 'ABC-12',
      resultBranchName: 'sisyphus/abc-12',
      model: 'claude-sonnet-4-5',
      instanceType: 'c7g.2xlarge',
      purchaseMode: 'spot',
      turnCap: 40,
      spendCap: '10.0000',
      turnsUsed: 14,
      spendUsed: '3.1400',
      originatingIntegrationId: null,
      reviewerSummary: null,
      needsReassignment: false,
      promptTruncated: false,
      createdAt: LAUNCHED,
      updatedAt: MOVED,
      ...(overrides.workflow ?? {}),
    },
    entries: overrides.entries ?? [],
    ownerDisplayName: 'Ada Lovelace',
    initiatedByDisplayName: 'Ada Lovelace',
    executionProfileName: 'API maintenance',
    originatingIntegrationName: null,
    workspaceId: 'workspace-1',
    workspaceName: 'Acme platform',
  }) as unknown as WorkflowDetailResult

describe('toWorkflowDetailReadouts', () => {
  it('carries the whole launch configuration, so nobody has to ask why it got these settings', () => {
    expect(toWorkflowDetailReadouts(detail(), NOW)).toMatchObject({
      runId: '0199a1f4…',
      type: 'delegated',
      model: 'claude-sonnet-4-5',
      instanceType: 'c7g.2xlarge',
      purchaseMode: 'spot',
      executionProfile: 'API maintenance',
      workspace: 'Acme platform',
      resultBranch: 'sisyphus/abc-12',
      startedAt: '2026-08-05 09:00',
      lastMovedAt: '2026-08-05 09:04',
      duration: '4:21',
      outcome: 'succeeded',
    })
  })

  it('measures a live run against now and a settled one against its last movement', () => {
    expect(
      toWorkflowDetailReadouts(
        detail({ workflow: { state: 'running', terminalOutcome: null } }),
        NOW,
      ).duration,
    ).toBe('10:00')
    expect(toWorkflowDetailReadouts(detail(), NOW).duration).toBe('4:21')
  })

  it('reports a cap and its consumption, with a meter to measure it', () => {
    const readouts = toWorkflowDetailReadouts(detail(), NOW)

    expect(readouts.turns).toStrictEqual({ used: '14', cap: '40', meter: { value: 14, max: 40 } })
    expect(readouts.spend).toStrictEqual({
      used: '3.1400',
      cap: '10.0000',
      meter: { value: 3.14, max: 10 },
    })
  })

  it('says an absent cap is uncapped, never a ceiling of zero', () => {
    const readouts = toWorkflowDetailReadouts(
      detail({ workflow: { turnCap: null, spendCap: null } }),
      NOW,
    )

    expect(readouts.turns).toStrictEqual({ used: '14', cap: undefined, meter: undefined })
    expect(readouts.spend.meter).toBeUndefined()
  })

  it('leaves a run still in flight with no outcome rather than inventing one', () => {
    const readouts = toWorkflowDetailReadouts(
      detail({ workflow: { state: 'running', terminalOutcome: null, outcomeReason: null } }),
      NOW,
    )

    expect(readouts.outcome).toBe('—')
    expect(readouts.outcomeReason).toBe('—')
  })

  it('surfaces the reassignment and truncation flags the run carries', () => {
    const readouts = toWorkflowDetailReadouts(
      detail({ workflow: { needsReassignment: true, promptTruncated: true } }),
      NOW,
    )

    expect(readouts.needsReassignment).toBe(true)
    expect(readouts.promptTruncated).toBe(true)
  })

  it('names the integration instead of a user when the run came from one', () => {
    const withIntegration = detail({ workflow: { originatingIntegrationId: 'integration-1' } })
    const readouts = toWorkflowDetailReadouts(
      { ...withIntegration, originatingIntegrationName: 'Acme Jira' },
      NOW,
    )

    expect(readouts.startedByLabel).toBe('integration')
    expect(readouts.startedBy).toBe('Acme Jira')
  })
})

describe('toWorkflowEntryReadouts', () => {
  const entry = {
    id: 'entry-1',
    repositoryUrl: 'https://git.test/acme/api',
    baseBranch: 'main',
    subdirectory: '.',
    isPrimary: true,
    resolvedCommit: 'a'.repeat(40),
    wasChanged: true,
    pullRequestUrl: 'https://git.test/acme/api/pull/9',
    entryResult: 'landed',
    stalenessNote: 'main advanced by 3 commits during this run.',
  }

  it('reads a completed entry', () => {
    expect(toWorkflowEntryReadouts(detail({ entries: [entry] }))[0]).toStrictEqual({
      id: 'entry-1',
      repositoryUrl: 'https://git.test/acme/api',
      baseBranch: 'main',
      subdirectory: '.',
      role: 'primary',
      resolvedCommit: 'a'.repeat(40),
      changed: 'changed',
      result: 'landed',
      pullRequestUrl: 'https://git.test/acme/api/pull/9',
      stalenessNote: 'main advanced by 3 commits during this run.',
    })
  })

  it('says an entry with no result yet is pending, not blank', () => {
    const readouts = toWorkflowEntryReadouts(
      detail({
        entries: [{ ...entry, entryResult: null, resolvedCommit: null, wasChanged: false }],
      }),
    )

    expect(readouts[0]?.result).toBe('pending')
    expect(readouts[0]?.resolvedCommit).toBe('—')
    expect(readouts[0]?.changed).toBe('unchanged')
  })

  it('marks a non-primary entry as secondary', () => {
    expect(
      toWorkflowEntryReadouts(detail({ entries: [{ ...entry, isPrimary: false }] }))[0]?.role,
    ).toBe('secondary')
  })
})

describe('toTimelineReadouts', () => {
  const event = (overrides: Partial<TimelineItem>): TimelineItem =>
    ({
      id: 'event-1',
      event: 'needs_attention',
      actorType: 'executor',
      actorUserId: null,
      actorDisplayName: null,
      detail: null,
      createdAt: LAUNCHED,
      ...overrides,
    }) as TimelineItem

  it('names the human where there is one', () => {
    expect(toTimelineReadouts([event({ actorDisplayName: 'Ada Lovelace' })])[0]?.actor).toBe(
      'Ada Lovelace',
    )
  })

  it('falls back to the actor type rather than to an empty attribution', () => {
    expect(toTimelineReadouts([event({})])[0]?.actor).toBe('executor')
  })

  it('reads an underscored event as words, and stamps it', () => {
    expect(toTimelineReadouts([event({})])[0]).toMatchObject({
      event: 'needs attention',
      at: '2026-08-05 09:00',
    })
  })

  it('preserves the order the procedure returned, which is oldest first', () => {
    const readouts = toTimelineReadouts([
      event({ id: 'a', event: 'provisioned' }),
      event({ id: 'b', event: 'started' }),
    ])

    expect(readouts.map((entry) => entry.id)).toStrictEqual(['a', 'b'])
  })
})

describe('toArtifactReadouts', () => {
  const artifact = (overrides: Partial<ArtifactItem>): ArtifactItem =>
    ({
      id: 'artifact-1',
      workflowId: 'workflow-1',
      entryId: null,
      kind: 'pull_request',
      s3Key: null,
      externalUrl: 'https://git.test/acme/api/pull/9',
      byteSize: null,
      expiresAt: null,
      createdAt: LAUNCHED,
      ...overrides,
    }) as ArtifactItem

  it('reads an external artifact as its URL', () => {
    expect(toArtifactReadouts([artifact({})], NOW)[0]).toMatchObject({
      kind: 'pull request',
      location: 'https://git.test/acme/api/pull/9',
      externalUrl: 'https://git.test/acme/api/pull/9',
      recordedAt: '2026-08-05 09:00',
      expired: undefined,
    })
  })

  it('reads a stored artifact as its object key', () => {
    expect(
      toArtifactReadouts(
        [artifact({ kind: 'diff', s3Key: 'artifacts/diff.patch', externalUrl: null })],
        NOW,
      )[0]?.location,
    ).toBe('artifacts/diff.patch')
  })

  it('keeps an expired artifact listed, with the date it expired (SC-012)', () => {
    const expired = toArtifactReadouts(
      [artifact({ expiresAt: new Date('2026-08-05T09:05:00.000Z') })],
      NOW,
    )

    expect(expired).toHaveLength(1)
    expect(expired[0]?.expired).toBe('2026-08-05 09:05')
  })

  it('does not call an artifact expired before its expiry has passed', () => {
    expect(
      toArtifactReadouts([artifact({ expiresAt: new Date('2026-09-01T00:00:00.000Z') })], NOW)[0]
        ?.expired,
    ).toBeUndefined()
  })
})
