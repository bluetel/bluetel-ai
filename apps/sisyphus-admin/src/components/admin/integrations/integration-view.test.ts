import { describe, expect, it } from 'vitest'

import type { IntegrationListingOutput } from './integration-view'
import {
  LISTING_CARRIES_NO_CREDENTIAL,
  toExtraFilters,
  toIntegrationView,
} from './integration-view'

const RUN: NonNullable<IntegrationListingOutput['lastRun']> = {
  id: 'run-1',
  integrationId: 'integration-1',
  trigger: 'scheduled',
  startedAt: new Date('2026-03-01T09:00:00.000Z'),
  endedAt: new Date('2026-03-01T09:00:40.000Z'),
  examinedCount: 12,
  matchedCount: 4,
  startedCount: 3,
  skippedCount: 1,
  skipReasons: { 'PROJ-9': 'matched no mapping' },
  error: null,
}

const listing = (overrides: Partial<IntegrationListingOutput> = {}): IntegrationListingOutput => ({
  id: 'integration-1',
  type: 'jira',
  name: 'Platform board',
  baseUrl: 'https://example.atlassian.net',
  projectPrefix: 'PROJ',
  label: 'autonomous',
  extraFilters: { status: 'To Do' },
  defaultOwnerUserId: 'user-1',
  promptIntro: 'Deliver the ticket.',
  cronExpression: '*/15 * * * *',
  timezone: 'Europe/London',
  perTickCeiling: 5,
  rollingPeriodCeiling: 20,
  rollingPeriodMinutes: 60,
  enabled: true,
  consecutiveFailures: 0,
  autoDisabledReason: null,
  scheduleArn: 'arn:aws:scheduler:::schedule/default/platform-board',
  createdAt: new Date('2026-02-01T00:00:00.000Z'),
  updatedAt: new Date('2026-02-02T00:00:00.000Z'),
  mappings: [
    {
      id: 'mapping-1',
      position: 0,
      criteria: { component: 'api' },
      executionProfileId: 'profile-1',
      executionProfileName: 'API delivery',
      isDefault: false,
    },
  ],
  claimedTicketCount: 7,
  startedWorkflowCount: 6,
  lastRun: RUN,
  ...overrides,
})

describe('toIntegrationView', () => {
  it('carries no credential of any kind — not the ARN, not a mask, not a flag (FR-098)', () => {
    const view = toIntegrationView(listing())
    const keys = Object.keys(view).join(' ').toLowerCase()

    expect(keys).not.toContain('credential')
    expect(keys).not.toContain('secret')
    expect(JSON.stringify(view)).not.toContain('arn:aws:secretsmanager')
  })

  it('is the compile-time assertion too: the listing type has no credential key', () => {
    // The annotation on this constant is `never` unless the key is absent, so a router change that
    // exposed it would fail `tsc` rather than this expectation. The runtime check is here only so
    // the guarantee is visible in the suite.
    expect(LISTING_CARRIES_NO_CREDENTIAL).toBe(true)
  })

  it('drops the row-keeping fields the screen has no use for', () => {
    expect(toIntegrationView(listing())).not.toHaveProperty('createdAt')
    expect(toIntegrationView(listing())).not.toHaveProperty('updatedAt')
  })

  it('keeps what the card reads: state, ceilings, schedule and counts (FR-105, FR-107, FR-155)', () => {
    const view = toIntegrationView(listing())

    expect(view).toMatchObject({
      id: 'integration-1',
      name: 'Platform board',
      enabled: true,
      cronExpression: '*/15 * * * *',
      timezone: 'Europe/London',
      perTickCeiling: 5,
      rollingPeriodCeiling: 20,
      claimedTicketCount: 7,
      startedWorkflowCount: 6,
    })
  })

  it('keeps the ordered mappings with the profile name an admin recognises (FR-130)', () => {
    expect(toIntegrationView(listing()).mappings).toStrictEqual([
      {
        id: 'mapping-1',
        position: 0,
        criteria: { component: 'api' },
        executionProfileId: 'profile-1',
        executionProfileName: 'API delivery',
        isDefault: false,
      },
    ])
  })

  it('summarises the last tick without its per-ticket skip reasons (FR-105)', () => {
    const run = toIntegrationView(listing()).lastRun

    expect(run).toStrictEqual({
      id: 'run-1',
      trigger: 'scheduled',
      startedAt: new Date('2026-03-01T09:00:00.000Z'),
      endedAt: new Date('2026-03-01T09:00:40.000Z'),
      examinedCount: 12,
      matchedCount: 4,
      startedCount: 3,
      skippedCount: 1,
      error: null,
    })
    expect(run).not.toHaveProperty('skipReasons')
  })

  it('reports a board that has never ticked as having no last run, not as a zeroed one', () => {
    expect(toIntegrationView(listing({ lastRun: undefined })).lastRun).toBeUndefined()
  })

  it('keeps the auto-disable reason, which is what makes FR-106 visible', () => {
    const view = toIntegrationView(
      listing({ enabled: false, consecutiveFailures: 5, autoDisabledReason: 'auto-disabled' }),
    )

    expect(view.autoDisabledReason).toBe('auto-disabled')
    expect(view.consecutiveFailures).toBe(5)
  })
})

describe('toExtraFilters', () => {
  it('passes an object through, which is the only shape the editor can render', () => {
    expect(toExtraFilters({ status: 'To Do' })).toStrictEqual({ status: 'To Do' })
  })

  it('reads null as no extra filters', () => {
    expect(toExtraFilters(null)).toBeNull()
  })

  it('refuses a scalar or an array rather than coercing it into a filter set', () => {
    expect(toExtraFilters('status=todo')).toBeNull()
    expect(toExtraFilters(7)).toBeNull()
    expect(toExtraFilters(['a', 'b'])).toBeNull()
    expect(toExtraFilters(undefined)).toBeNull()
  })
})
