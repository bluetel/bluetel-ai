import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * These tests exercise the `runtimeEnv` wiring, not the process environment: a
 * key present in a schema but absent from the explicit `runtimeEnv` map is the
 * one failure mode the map itself introduces, and it is invisible until boot.
 */
const completeEnvironment: Readonly<Record<string, string>> = {
  DATABASE_URL: 'postgres://sisyphus@db.internal:5432/sisyphus',
  AUTH_SECRET: 'auth-secret',
  AUTH_GOOGLE_ID: 'google-client-id',
  AUTH_GOOGLE_SECRET: 'google-client-secret',
  SISYPHUS_PERMITTED_EMAIL_DOMAINS: 'bluetel.co.uk, example.com',
  SISYPHUS_MACHINE_CREDENTIAL_SECRET: 'machine-secret',
  SISYPHUS_LOGS_BUCKET: 'sisyphus-staging-logs',
  SISYPHUS_BUNDLES_BUCKET: 'sisyphus-staging-bundles',
  SISYPHUS_ARTIFACTS_BUCKET: 'sisyphus-staging-artifacts',
  SISYPHUS_STAGE: 'staging',
  NEXT_PUBLIC_NODE_ENV: 'test',
  NEXT_PUBLIC_SITE_URL: 'https://sisyphus.example.com',
}

const stubEnvironment = (overrides: Readonly<Record<string, string>> = {}): void => {
  vi.stubEnv('SKIP_ENV_VALIDATION', '')
  // Empty string is treated as undefined by createSafeEnv, so this exercises
  // the schema default rather than whatever the host happens to export.
  vi.stubEnv('AWS_REGION', '')
  vi.stubEnv('SISYPHUS_WEBHOOK_SIGNING_SECRET', '')

  for (const [key, value] of Object.entries({ ...completeEnvironment, ...overrides })) {
    vi.stubEnv(key, value)
  }
}

const importEnv = async () => {
  vi.resetModules()

  return import('./env')
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('env', () => {
  it('validates and exposes every declared variable', async () => {
    stubEnvironment()

    const { env } = await importEnv()

    expect(env.DATABASE_URL).toBe('postgres://sisyphus@db.internal:5432/sisyphus')
    expect(env.SISYPHUS_LOGS_BUCKET).toBe('sisyphus-staging-logs')
    expect(env.SISYPHUS_STAGE).toBe('staging')
    expect(env.NEXT_PUBLIC_SITE_URL).toBe('https://sisyphus.example.com')
  })

  it('applies schema transforms, so consumers get a list rather than a string', async () => {
    stubEnvironment()

    const { env } = await importEnv()

    expect(env.SISYPHUS_PERMITTED_EMAIL_DOMAINS).toEqual(['bluetel.co.uk', 'example.com'])
  })

  it('treats an empty string as undefined and falls back to the default region', async () => {
    stubEnvironment()

    const { env } = await importEnv()

    expect(env.AWS_REGION).toBe('eu-west-2')
    expect(env.SISYPHUS_WEBHOOK_SIGNING_SECRET).toBeUndefined()
  })

  it('fails at import naming the missing variable, rather than yielding undefined', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    stubEnvironment({ SISYPHUS_LOGS_BUCKET: '' })

    await expect(importEnv()).rejects.toThrow('SISYPHUS_LOGS_BUCKET')
  })

  it('names the variable for a value that is present but invalid', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    stubEnvironment({ DATABASE_URL: 'not-a-url' })

    await expect(importEnv()).rejects.toThrow('DATABASE_URL')
  })

  it('skips validation entirely when SKIP_ENV_VALIDATION is set', async () => {
    vi.stubEnv('SKIP_ENV_VALIDATION', 'true')

    await expect(importEnv()).resolves.toHaveProperty('env')
  })
})
