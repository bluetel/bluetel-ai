import { describe, expect, it } from 'vitest'

import * as barrel from './index'

describe('the integrations barrel', () => {
  it('exports the screen, its parts and the client adapter', () => {
    for (const name of [
      'IntegrationsScreen',
      'IntegrationsPanel',
      'IntegrationCard',
      'IntegrationEditor',
      'CredentialField',
      'ScheduleField',
      'PromptPreview',
      'useIntegrationsApiClient',
      'toIntegrationView',
      'toProfileOptions',
      'toOwnerOptions',
      'toIntegrationReadouts',
      'toCreateIntegrationValues',
      'scheduleReadback',
    ]) {
      expect(barrel).toHaveProperty(name)
    }
  })

  it('no longer offers the unmounted-router fallback, which would now be a false report (T199)', () => {
    expect(barrel).not.toHaveProperty('createUnavailableIntegrationsClient')
    expect(barrel).not.toHaveProperty('INTEGRATIONS_UNAVAILABLE')
  })

  it('exports no credential helper of any kind, because there is nothing to read back', () => {
    expect(
      Object.keys(barrel).filter((name) => name.toLowerCase().includes('credential')),
    ).toStrictEqual(['CredentialField', 'EDIT_CREDENTIAL_NOTICE'])
  })
})
