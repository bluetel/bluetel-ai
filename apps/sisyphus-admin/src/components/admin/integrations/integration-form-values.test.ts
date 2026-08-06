import { describe, expect, it } from 'vitest'

import type { IntegrationDraft } from './integration-form-values'
import {
  draftFromIntegration,
  EDIT_CREDENTIAL_NOTICE,
  EMPTY_INTEGRATION,
  toCreateIntegrationValues,
  toUpdateIntegrationValues,
} from './integration-form-values'
import type { IntegrationView } from './integrations-client'

const NOW = new Date('2026-08-05T10:00:00Z')
const PROFILE = '33333333-3333-4333-8333-333333333333'
const OWNER = '44444444-4444-4444-8444-444444444444'

const complete: IntegrationDraft = {
  name: 'Payments board',
  baseUrl: 'https://boards.invalid',
  credentialSecretArn: 'arn:fixture:secret:board',
  projectPrefix: 'FIX',
  label: 'sisyphus',
  extraFilters: '',
  defaultOwnerUserId: OWNER,
  promptIntro: 'Work from this board ships as one pull request.',
  cronExpression: '0/15 * * * *',
  timezone: 'Europe/London',
  perTickCeiling: '3',
  rollingPeriodCeiling: '12',
  rollingPeriodMinutes: '60',
  mappings: [{ position: '0', criteria: '', executionProfileId: PROFILE, isDefault: true }],
}

const integration: IntegrationView = {
  id: '55555555-5555-4555-8555-555555555555',
  type: 'jira',
  name: 'Payments board',
  baseUrl: 'https://boards.invalid',
  projectPrefix: 'FIX',
  label: 'sisyphus',
  extraFilters: { status: 'Ready' },
  defaultOwnerUserId: OWNER,
  promptIntro: 'Work from this board ships as one pull request.',
  cronExpression: '0/15 * * * *',
  timezone: 'Europe/London',
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
      criteria: { issueType: 'Bug' },
      executionProfileId: PROFILE,
      executionProfileName: 'Payments',
      isDefault: false,
    },
  ],
  claimedTicketCount: 4,
  startedWorkflowCount: 3,
  lastRun: undefined,
}

describe('the empty draft', () => {
  it('chooses nothing, including the schedule and the timezone', () => {
    expect(EMPTY_INTEGRATION.cronExpression).toBe('')
    expect(EMPTY_INTEGRATION.timezone).toBe('')
    expect(EMPTY_INTEGRATION.mappings).toEqual([])
  })
})

describe('draftFromIntegration (FR-098)', () => {
  it('never carries the credential back into the form', () => {
    expect(draftFromIntegration(integration).credentialSecretArn).toBe('')
  })

  it('carries everything else the editor needs', () => {
    const draft = draftFromIntegration(integration)

    expect(draft.name).toBe('Payments board')
    expect(draft.perTickCeiling).toBe('3')
    expect(draft.mappings[0].executionProfileId).toBe(PROFILE)
  })

  it('renders JSON fields as JSON, so they can be edited as written', () => {
    expect(JSON.parse(draftFromIntegration(integration).extraFilters)).toEqual({ status: 'Ready' })
    expect(JSON.parse(draftFromIntegration(integration).mappings[0].criteria)).toEqual({
      issueType: 'Bug',
    })
  })

  it('renders absent extra filters as blank rather than as the word null', () => {
    expect(draftFromIntegration({ ...integration, extraFilters: null }).extraFilters).toBe('')
  })

  it('has a notice explaining the credential, so an admin meets a rule rather than an empty box', () => {
    expect(EDIT_CREDENTIAL_NOTICE).toContain('write-only')
  })
})

describe('toCreateIntegrationValues', () => {
  it('accepts a complete draft', () => {
    const result = toCreateIntegrationValues(complete, NOW)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.input.perTickCeiling).toBe(3)
    expect(result.input.mappings[0].criteria).toEqual({})
  })

  it('trims the values, so a pasted ARN with a trailing space is still the same secret', () => {
    const result = toCreateIntegrationValues(
      { ...complete, credentialSecretArn: '  arn:fixture:secret:board  ' },
      NOW,
    )

    if (!result.ok) throw new Error('the draft was refused')
    expect(result.input.credentialSecretArn).toBe('arn:fixture:secret:board')
  })

  it('refuses extra filters that are not a JSON object', () => {
    const result = toCreateIntegrationValues({ ...complete, extraFilters: '[1, 2]' }, NOW)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.errors.extraFilters?.code).toBe('not_a_json_object')
  })

  it('refuses a mapping criterion that is not a JSON object', () => {
    const result = toCreateIntegrationValues(
      {
        ...complete,
        mappings: [
          { position: '0', criteria: 'Bug', executionProfileId: PROFILE, isDefault: true },
        ],
      },
      NOW,
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.errors.mappings).toBeDefined()
  })

  it('refuses a timezone the platform cannot evaluate (FR-155)', () => {
    const result = toCreateIntegrationValues({ ...complete, timezone: 'Mars/Olympus_Mons' }, NOW)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.errors.timezone?.code).toBe('unknown_timezone')
  })

  it('refuses a schedule whose fire times cannot be shown (FR-154)', () => {
    const result = toCreateIntegrationValues(
      { ...complete, cronExpression: 'every fifteen minutes' },
      NOW,
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.errors.cronExpression?.code).toBe('unreadable_schedule')
  })

  it('refuses an empty prompt intro, using the server own schema (FR-158)', () => {
    const result = toCreateIntegrationValues({ ...complete, promptIntro: '' }, NOW)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.errors.promptIntro).toBeDefined()
  })

  it('refuses a ceiling that is not a positive integer, because an unbounded tick is a bill', () => {
    const result = toCreateIntegrationValues({ ...complete, perTickCeiling: '' }, NOW)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.errors.perTickCeiling).toBeDefined()
  })

  it('refuses duplicate mapping positions, because first match must be decidable (FR-130)', () => {
    const result = toCreateIntegrationValues(
      {
        ...complete,
        mappings: [
          { position: '0', criteria: '', executionProfileId: PROFILE, isDefault: false },
          { position: '0', criteria: '', executionProfileId: PROFILE, isDefault: false },
        ],
      },
      NOW,
    )

    expect(result.ok).toBe(false)
  })

  it('reports every failing field at once rather than one per attempt', () => {
    const result = toCreateIntegrationValues(
      { ...EMPTY_INTEGRATION, timezone: 'Mars/Olympus_Mons' },
      NOW,
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(Object.keys(result.errors).length).toBeGreaterThan(3)
  })
})

describe('toUpdateIntegrationValues', () => {
  it('addresses the integration being edited', () => {
    const result = toUpdateIntegrationValues('an-id', complete, NOW)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.input.integrationId).toBe('an-id')
  })

  it('applies the same refusals as create, so an edit cannot bypass them', () => {
    expect(toUpdateIntegrationValues('an-id', { ...complete, promptIntro: '' }, NOW).ok).toBe(false)
  })

  it('still requires the credential, which is what makes it write-only end to end (FR-098)', () => {
    expect(
      toUpdateIntegrationValues('an-id', { ...complete, credentialSecretArn: '' }, NOW).ok,
    ).toBe(false)
  })
})
