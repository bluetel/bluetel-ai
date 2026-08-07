import { describe, expect, it } from 'vitest'

import { getMissingOidcProviderMessage } from './missing-oidc-provider-message'

describe('getMissingOidcProviderMessage', () => {
  it('names the stage that could not be bootstrapped', () => {
    expect(getMissingOidcProviderMessage('staging')).toContain('"staging"')
  })

  it('names the command that creates the provider, because "NoSuchEntity" does not', () => {
    expect(getMissingOidcProviderMessage('staging')).toContain(
      'pnpm nx run sisyphus-admin:bootstrap --configuration=production',
    )
  })

  it('names the issuer it looked for', () => {
    expect(getMissingOidcProviderMessage('staging')).toContain(
      'https://token.actions.githubusercontent.com',
    )
  })
})
