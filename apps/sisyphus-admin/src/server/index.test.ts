import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The barrel reaches Auth.js and the database handle, so it is imported through a stubbed
 * environment. What is asserted is the published surface: a route handler needs the dependency
 * factory, a server component needs the gate, and a later task needs the denial seam by name.
 */
const environment: Readonly<Record<string, string>> = {
  DATABASE_URL: 'postgres://sisyphus@db.invalid:5432/sisyphus',
  AUTH_SECRET: 'auth-secret',
  AUTH_GOOGLE_ID: 'google-client-id',
  AUTH_GOOGLE_SECRET: 'google-client-secret',
  SISYPHUS_PERMITTED_EMAIL_DOMAINS: 'bluetel.co.uk',
  SISYPHUS_MACHINE_CREDENTIAL_SECRET: 'machine-secret',
  SISYPHUS_SLACK_BOT_TOKEN: 'slack-bot-token-fixture',
  SISYPHUS_PANEL_URL: 'https://sisyphus.example.com',
  SISYPHUS_LOGS_BUCKET: 'logs',
  SISYPHUS_BUNDLES_BUCKET: 'bundles',
  SISYPHUS_ARTIFACTS_BUCKET: 'artifacts',
  SISYPHUS_STAGE: 'test',
  NEXT_PUBLIC_NODE_ENV: 'test',
  NEXT_PUBLIC_SITE_URL: 'https://sisyphus.example.com',
}

const importBarrel = async () => {
  vi.resetModules()
  vi.stubEnv('SKIP_ENV_VALIDATION', '')
  vi.stubEnv('AUTH_URL', 'https://sisyphus.example.com')
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value)
  return import('./index')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the server barrel', () => {
  it('publishes exactly the wiring the panel consumes', async () => {
    expect(Object.keys(await importBarrel()).sort()).toStrictEqual([
      'CREDENTIAL_HEADER',
      'SCOPED_CREDENTIAL_AUDIENCE',
      'SCOPED_CREDENTIAL_ISSUER',
      'SIGN_IN_PATH',
      'bearerTokenFrom',
      'createDenialRecorder',
      'createLoggingDenialWriter',
      'createMachineDependencies',
      'createScopedCredentialResolver',
      'createServerCaller',
      'createSisyphusDependencies',
      'decideAdminPageAccess',
      'formatDenial',
      'recordDenial',
      'requireAdminPage',
      'resolveNoMachineCredential',
      'resolveNoSession',
      'resolveSisyphusSession',
      'toSisyphusSession',
      'verifyScopedCredential',
      'workflowIdFromSubject',
    ])
  })

  it('keeps the denial writer seam addressable by name, so it can be replaced in one place', async () => {
    const barrel = await importBarrel()

    expect(typeof barrel.createDenialRecorder).toBe('function')
    expect(typeof barrel.createLoggingDenialWriter).toBe('function')
  })
})
