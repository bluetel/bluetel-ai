import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The route is two re-exports, and the thing worth asserting is that both verbs are mounted:
 * Auth.js serves the sign-in redirect on `GET` and the provider callback on `POST`, so exporting
 * one and not the other produces a sign-in flow that starts and never completes.
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

const importRoute = async () => {
  vi.resetModules()
  vi.stubEnv('SKIP_ENV_VALIDATION', '')
  vi.stubEnv('AUTH_URL', 'https://sisyphus.example.com')
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value)
  return import('./route')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the [...nextauth] route', () => {
  it('mounts both verbs', async () => {
    const { GET, POST } = await importRoute()
    expect(typeof GET).toBe('function')
    expect(typeof POST).toBe('function')
  })
})
