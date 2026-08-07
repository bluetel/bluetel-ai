import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The config module is wiring, so these tests assert the wiring decisions that carry a
 * requirement — above all that the session strategy is `database` and not `jwt` (FR-175). The
 * policy itself is tested in `callbacks.test.ts` and `permitted-domains.test.ts`.
 */

const environment: Readonly<Record<string, string>> = {
  DATABASE_URL: 'postgres://sisyphus@db.invalid:5432/sisyphus',
  AUTH_SECRET: 'auth-secret',
  AUTH_GOOGLE_ID: 'google-client-id',
  AUTH_GOOGLE_SECRET: 'google-client-secret',
  SISYPHUS_PERMITTED_EMAIL_DOMAINS: 'bluetel.co.uk, example.com',
  SISYPHUS_MACHINE_CREDENTIAL_SECRET: 'machine-secret',
  SISYPHUS_LOGS_BUCKET: 'logs',
  SISYPHUS_BUNDLES_BUCKET: 'bundles',
  SISYPHUS_ARTIFACTS_BUCKET: 'artifacts',
  SISYPHUS_STAGE: 'test',
  NEXT_PUBLIC_NODE_ENV: 'test',
  NEXT_PUBLIC_SITE_URL: 'https://sisyphus.example.com',
}

const importConfig = async () => {
  vi.resetModules()
  vi.stubEnv('SKIP_ENV_VALIDATION', '')
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value)
  // The module exports a factory rather than a constant, so that importing a route does not open a
  // database pool. Calling it here is what the request path does.
  const { createAuthConfig } = await import('./config')
  return { authConfig: createAuthConfig() }
}

/** The provider's authorization params, which Auth.js keeps under `options` on the built provider. */
const authorizationParams = async (): Promise<Record<string, unknown> | undefined> => {
  const { authConfig } = await importConfig()
  const [provider] = authConfig.providers
  return (
    provider as {
      options?: { authorization?: { params?: Record<string, unknown> } }
    }
  ).options?.authorization?.params
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('authConfig', () => {
  it('uses database-backed sessions, so deactivation lands at the next request (FR-175)', async () => {
    const { authConfig } = await importConfig()
    expect(authConfig.session?.strategy).toBe('database')
    // Stated as an inequality too: `jwt` is the default, so this is a decision, not an omission.
    expect(authConfig.session?.strategy).not.toBe('jwt')
  })

  it('installs an adapter, without which a database session has nowhere to live', async () => {
    const { authConfig } = await importConfig()
    expect(typeof authConfig.adapter?.createSession).toBe('function')
    expect(typeof authConfig.adapter?.getSessionAndUser).toBe('function')
  })

  it('offers exactly one provider, and it is Google (FR-011)', async () => {
    const { authConfig } = await importConfig()
    expect(authConfig.providers).toHaveLength(1)
    const [provider] = authConfig.providers
    expect(provider).toMatchObject({ id: 'google' })
  })

  it('requests identity scopes only', async () => {
    expect(await authorizationParams()).toMatchObject({ scope: 'openid email profile' })
  })

  it('sends the first permitted domain as a chooser hint only', async () => {
    const { authConfig } = await importConfig()
    // A hint that pre-fills Google's account chooser, not the control. The control is the `hd`
    // claim check in the signIn callback, which is why that callback has to exist.
    expect(await authorizationParams()).toMatchObject({ hd: 'bluetel.co.uk' })
    expect(typeof authConfig.callbacks?.signIn).toBe('function')
  })

  it('sends sign-in and error traffic to the panel’s own page, not the stock chooser', async () => {
    const { authConfig } = await importConfig()
    expect(authConfig.pages?.signIn).toBe('/sign-in')
    expect(authConfig.pages?.error).toBe('/sign-in')
  })
})
