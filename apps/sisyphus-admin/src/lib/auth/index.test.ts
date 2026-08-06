import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The barrel is the only place `NextAuth()` is called, so this asserts that the call produces the
 * four things the rest of the app consumes. A second `NextAuth()` elsewhere would create a second
 * adapter and a second pool against the same tables.
 */

const environment: Readonly<Record<string, string>> = {
  DATABASE_URL: 'postgres://sisyphus@db.invalid:5432/sisyphus',
  AUTH_SECRET: 'auth-secret',
  AUTH_GOOGLE_ID: 'google-client-id',
  AUTH_GOOGLE_SECRET: 'google-client-secret',
  SISYPHUS_PERMITTED_EMAIL_DOMAINS: 'bluetel.co.uk',
  SISYPHUS_MACHINE_CREDENTIAL_SECRET: 'machine-secret',
  SISYPHUS_LOGS_BUCKET: 'logs',
  SISYPHUS_BUNDLES_BUCKET: 'bundles',
  SISYPHUS_ARTIFACTS_BUCKET: 'artifacts',
  SISYPHUS_STAGE: 'test',
  NEXT_PUBLIC_NODE_ENV: 'test',
  NEXT_PUBLIC_SITE_URL: 'https://sisyphus.example.com',
}

const importAuth = async () => {
  vi.resetModules()
  vi.stubEnv('SKIP_ENV_VALIDATION', '')
  vi.stubEnv('AUTH_URL', 'https://sisyphus.example.com')
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value)
  return import('./index')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the auth barrel', () => {
  it('exposes the route handlers the [...nextauth] route mounts', async () => {
    const { handlers } = await importAuth()
    expect(typeof handlers.GET).toBe('function')
    expect(typeof handlers.POST).toBe('function')
  })

  it('exposes auth, signIn and signOut for server code', async () => {
    const { auth, signIn, signOut } = await importAuth()
    expect(typeof auth).toBe('function')
    expect(typeof signIn).toBe('function')
    expect(typeof signOut).toBe('function')
  })

  it('re-exports the gate so consumers never reach past the barrel for it', async () => {
    const barrel = await importAuth()
    expect(typeof barrel.verifyPermittedDomain).toBe('function')
    expect(typeof barrel.decideSignIn).toBe('function')
    expect(typeof barrel.isActiveSessionUser).toBe('function')
    expect(typeof barrel.isAdminSessionUser).toBe('function')
    expect(typeof barrel.createSisyphusAdapter).toBe('function')
  })
})
