import { describe, expect, it } from 'vitest'

import * as barrel from './index'

describe('the integrations barrel', () => {
  it('exports the screen, its parts and the client port', () => {
    for (const name of [
      'IntegrationsPanel',
      'IntegrationCard',
      'IntegrationEditor',
      'CredentialField',
      'ScheduleField',
      'PromptPreview',
      'createUnavailableIntegrationsClient',
      'toIntegrationReadouts',
      'toCreateIntegrationValues',
      'scheduleReadback',
    ]) {
      expect(barrel).toHaveProperty(name)
    }
  })

  it('exports no credential helper of any kind, because there is nothing to read back', () => {
    expect(
      Object.keys(barrel).filter((name) => name.toLowerCase().includes('credential')),
    ).toStrictEqual(['CredentialField', 'EDIT_CREDENTIAL_NOTICE'])
  })
})
