import { describe, expect, it } from 'vitest'

import {
  createIntegrationInput,
  integrationMappingInput,
  integrationMappingListInput,
  listIntegrationsInput,
  previewIntegrationPromptInput,
  setIntegrationEnabledInput,
  updateIntegrationInput,
} from './integration'

const ID = '01890a5d-ac96-774b-bcce-b302099a8057'

const mapping = (overrides: Record<string, unknown> = {}) => ({
  position: 0,
  criteria: { labels: ['agent-ready'] },
  executionProfileId: ID,
  ...overrides,
})

const settings = {
  name: 'client jira',
  baseUrl: 'https://example.atlassian.net',
  credentialSecretArn: 'arn:aws:secretsmanager:eu-west-1:1:secret:jira',
  projectPrefix: 'BTAI',
  label: 'agent-ready',
  promptIntro: 'You are working on a ticket.',
  cronExpression: 'rate(15 minutes)',
  timezone: 'Europe/London',
  perTickCeiling: 3,
  rollingPeriodCeiling: 10,
  rollingPeriodMinutes: 60,
  mappings: [mapping()],
}

describe('the integration inputs', () => {
  it('never carry a credential value — only the ARN of one', () => {
    const keys = Object.keys(createIntegrationInput.shape)

    expect(keys).toContain('credentialSecretArn')
    expect(keys).not.toContain('apiToken')
    expect(keys).not.toContain('password')
    expect(keys).not.toContain('credential')
  })
})

describe('integrationMappingInput', () => {
  it('carries a position, because first match wins (FR-130)', () => {
    expect(integrationMappingInput.parse(mapping())).toMatchObject({ position: 0 })
  })

  it('is not the default unless it says so', () => {
    expect(integrationMappingInput.parse(mapping()).isDefault).toBe(false)
  })
})

describe('integrationMappingListInput', () => {
  it('refuses duplicate positions — order must be decided, not incidental', () => {
    expect(
      integrationMappingListInput.safeParse([mapping(), mapping({ executionProfileId: ID })])
        .success,
    ).toBe(false)
  })

  it('refuses two defaults', () => {
    expect(
      integrationMappingListInput.safeParse([
        mapping({ isDefault: true }),
        mapping({ position: 1, isDefault: true }),
      ]).success,
    ).toBe(false)
  })

  it('accepts an ordered list with at most one default', () => {
    expect(
      integrationMappingListInput.safeParse([mapping(), mapping({ position: 1, isDefault: true })])
        .success,
    ).toBe(true)
  })
})

describe('createIntegrationInput', () => {
  it('requires the ceilings — an unbounded tick is an unbounded bill (FR-105)', () => {
    const withoutCeiling: Record<string, unknown> = { ...settings }
    Reflect.deleteProperty(withoutCeiling, 'perTickCeiling')

    expect(createIntegrationInput.safeParse({ ...settings, type: 'jira' }).success).toBe(true)
    expect(createIntegrationInput.safeParse({ ...withoutCeiling, type: 'jira' }).success).toBe(
      false,
    )
  })

  it('rejects an integration type outside the vocabulary', () => {
    expect(createIntegrationInput.safeParse({ ...settings, type: 'linear' }).success).toBe(false)
  })

  it('rejects a base URL that is not a URL', () => {
    expect(
      createIntegrationInput.safeParse({ ...settings, type: 'jira', baseUrl: 'example' }).success,
    ).toBe(false)
  })
})

describe('updateIntegrationInput', () => {
  it('cannot change the type — that would reinterpret every existing mapping', () => {
    expect(Object.keys(updateIntegrationInput.shape)).not.toContain('type')
  })
})

describe('previewIntegrationPromptInput and setIntegrationEnabledInput', () => {
  it('name a sample ticket so the assembled prompt can be reviewed before enable (FR-160)', () => {
    expect(
      previewIntegrationPromptInput.parse({ integrationId: ID, externalId: 'BTAI-42' }),
    ).toStrictEqual({ integrationId: ID, externalId: 'BTAI-42' })
    expect(setIntegrationEnabledInput.parse({ integrationId: ID, enabled: true })).toStrictEqual({
      integrationId: ID,
      enabled: true,
    })
  })
})

describe('listIntegrationsInput', () => {
  it('lists everything by default, because an admin manages disabled ones too', () => {
    expect(listIntegrationsInput.parse({}).enabledOnly).toBe(false)
  })
})
