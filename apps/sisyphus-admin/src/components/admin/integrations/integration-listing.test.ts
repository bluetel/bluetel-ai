import { describe, expect, it } from 'vitest'

import { toIntegrationReadouts, wasAutoDisabled } from './integration-listing'
import type { IntegrationView } from './integrations-client'

const NOW = new Date('2026-08-05T10:00:00Z')

const integration = (overrides: Partial<IntegrationView> = {}): IntegrationView => ({
  id: '55555555-5555-4555-8555-555555555555',
  type: 'jira',
  name: 'Payments board',
  baseUrl: 'https://boards.invalid',
  projectPrefix: 'FIX',
  label: 'sisyphus',
  extraFilters: null,
  defaultOwnerUserId: '44444444-4444-4444-8444-444444444444',
  promptIntro: 'Work from this board ships as one pull request.',
  cronExpression: '0 9 * * *',
  timezone: 'Australia/Sydney',
  perTickCeiling: 3,
  rollingPeriodCeiling: 12,
  rollingPeriodMinutes: 60,
  enabled: true,
  consecutiveFailures: 0,
  autoDisabledReason: null,
  scheduleArn: 'sisyphus-integration-55555555',
  mappings: [
    {
      id: 'mapping-1',
      position: 0,
      criteria: {},
      executionProfileId: 'profile-1',
      executionProfileName: 'Payments',
      isDefault: true,
    },
  ],
  claimedTicketCount: 4,
  startedWorkflowCount: 3,
  lastRun: undefined,
  ...overrides,
})

describe('wasAutoDisabled (FR-106)', () => {
  it('distinguishes the platform switching it off from an admin doing it', () => {
    expect(
      wasAutoDisabled({ autoDisabledReason: 'auto-disabled after 5 consecutive failed ticks: x' }),
    ).toBe(true)
    expect(wasAutoDisabled({ autoDisabledReason: null })).toBe(false)
    expect(wasAutoDisabled({ autoDisabledReason: 'off during the migration' })).toBe(false)
  })
})

describe('toIntegrationReadouts (T121, FR-155)', () => {
  it('describes the schedule in plain language', () => {
    expect(toIntegrationReadouts(integration(), NOW).schedule).toBe('at 09:00 every day')
  })

  it('renders the next runs in the board timezone, never the reader timezone', () => {
    const readouts = toIntegrationReadouts(integration(), NOW)

    expect(readouts.timezone).toBe('Australia/Sydney')
    expect(readouts.nextRuns[0]).toBe('2026-08-06 09:00')
  })

  it('gives no fire times for a schedule it cannot read, rather than a wrong list', () => {
    expect(
      toIntegrationReadouts(integration({ cronExpression: 'every fifteen minutes' }), NOW).nextRuns,
    ).toEqual([])
  })

  it('reads as enabled, disabled or auto-disabled — three states, not two', () => {
    expect(toIntegrationReadouts(integration(), NOW).state).toBe('enabled')
    expect(toIntegrationReadouts(integration({ enabled: false }), NOW).state).toBe('disabled')
    expect(
      toIntegrationReadouts(
        integration({
          enabled: false,
          autoDisabledReason: 'auto-disabled after 5 consecutive failed ticks: unreachable',
        }),
        NOW,
      ).state,
    ).toBe('auto-disabled')
  })

  it('carries the auto-disable reason only when the platform wrote it', () => {
    expect(
      toIntegrationReadouts(integration({ enabled: false, autoDisabledReason: 'manual' }), NOW)
        .autoDisabledReason,
    ).toBeUndefined()
  })

  it('names the profiles a ticket could resolve to', () => {
    expect(toIntegrationReadouts(integration(), NOW).mappingSummary).toBe('Payments')
  })

  it('says outright when there are no mappings, since every ticket would be skipped', () => {
    expect(toIntegrationReadouts(integration({ mappings: [] }), NOW).mappingSummary).toContain(
      'every ticket found would be skipped',
    )
  })

  it('abbreviates a long mapping list rather than filling the card', () => {
    const many = Array.from({ length: 6 }, (_, index) => ({
      id: `mapping-${String(index)}`,
      position: index,
      criteria: {},
      executionProfileId: `profile-${String(index)}`,
      executionProfileName: `Profile ${String(index)}`,
      isDefault: false,
    }))

    expect(toIntegrationReadouts(integration({ mappings: many }), NOW).mappingSummary).toContain(
      'and 3 more',
    )
  })

  it('states both ceilings together, because they are one decision', () => {
    expect(toIntegrationReadouts(integration(), NOW).ceilings).toBe('3 per tick, 12 per 60 minutes')
  })

  it('says a board has never ticked rather than showing a blank', () => {
    expect(toIntegrationReadouts(integration(), NOW).lastRun).toBe('never ticked')
  })

  it('leads a failed tick with the failure', () => {
    const readouts = toIntegrationReadouts(
      integration({
        lastRun: {
          id: 'run-1',
          trigger: 'scheduled',
          startedAt: new Date('2026-08-05T09:00:00Z'),
          endedAt: new Date('2026-08-05T09:00:05Z'),
          examinedCount: 0,
          matchedCount: 0,
          startedCount: 0,
          skippedCount: 0,
          error: 'the board could not be reached',
        },
      }),
      NOW,
    )

    expect(readouts.lastRun).toContain('failed: the board could not be reached')
  })

  it('says a tick is still running rather than reporting zero counts as a result', () => {
    const readouts = toIntegrationReadouts(
      integration({
        lastRun: {
          id: 'run-1',
          trigger: 'manual',
          startedAt: new Date('2026-08-05T09:59:00Z'),
          endedAt: null,
          examinedCount: 0,
          matchedCount: 0,
          startedCount: 0,
          skippedCount: 0,
          error: null,
        },
      }),
      NOW,
    )

    expect(readouts.lastRun).toContain('still running')
  })

  it('summarises a completed tick with what it did', () => {
    const readouts = toIntegrationReadouts(
      integration({
        lastRun: {
          id: 'run-1',
          trigger: 'scheduled',
          startedAt: new Date('2026-08-05T09:00:00Z'),
          endedAt: new Date('2026-08-05T09:00:05Z'),
          examinedCount: 7,
          matchedCount: 4,
          startedCount: 2,
          skippedCount: 2,
          error: null,
        },
      }),
      NOW,
    )

    expect(readouts.lastRun).toContain('examined 7, started 2, skipped 2')
  })

  it('says whether the schedule has actually been registered', () => {
    expect(toIntegrationReadouts(integration(), NOW).scheduleRegistered).toBe(true)
    expect(toIntegrationReadouts(integration({ scheduleArn: null }), NOW).scheduleRegistered).toBe(
      false,
    )
  })
})
