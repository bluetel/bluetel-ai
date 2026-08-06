import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The pool is memoised on the module so a warm serverless container reuses one set of connections
 * across invocations. Opening a pool per request exhausts the database's connection ceiling long
 * before it exhausts anything in this process, and it fails under load rather than in a test.
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

const importDatabase = async () => {
  vi.resetModules()
  vi.stubEnv('SKIP_ENV_VALIDATION', '')
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value)
  return import('./database')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('getAuthDatabase', () => {
  it('hands back the same handle rather than opening a pool per call', async () => {
    const { getAuthDatabase } = await importDatabase()
    expect(getAuthDatabase()).toBe(getAuthDatabase())
  })

  it('does not connect at import time — the driver connects on first query', async () => {
    // Importing must not require a reachable database; `db.invalid` never resolves.
    const { getAuthDatabase } = await importDatabase()
    expect(typeof getAuthDatabase().select).toBe('function')
  })
})
