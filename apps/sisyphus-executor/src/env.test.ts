import { afterEach, describe, expect, it, vi } from 'vitest'

const completeEnvironment: Readonly<Record<string, string>> = {
  SISYPHUS_STAGE: 'staging',
  SISYPHUS_MACHINE_SURFACE_URL: 'https://sisyphus.example.com/api/machine',
  SISYPHUS_LOGS_BUCKET: 'sisyphus-staging-logs',
  SISYPHUS_SNAPSHOTS_BUCKET: 'sisyphus-staging-snapshots',
  SISYPHUS_BUNDLES_BUCKET: 'sisyphus-staging-bundles',
  SISYPHUS_ARTIFACTS_BUCKET: 'sisyphus-staging-artifacts',
}

const stubEnvironment = (overrides: Readonly<Record<string, string>> = {}): void => {
  vi.stubEnv('SKIP_ENV_VALIDATION', '')
  vi.stubEnv('AWS_REGION', '')
  vi.stubEnv('SISYPHUS_WORKSPACE_ROOT', '')

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

    expect(env.SISYPHUS_STAGE).toBe('staging')
    expect(env.SISYPHUS_BUNDLES_BUCKET).toBe('sisyphus-staging-bundles')
    expect(env.AWS_REGION).toBe('eu-west-2')
    expect(env.SISYPHUS_WORKSPACE_ROOT).toBe('/workspace')
  })

  it('fails at import naming the missing variable, rather than yielding undefined', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    stubEnvironment({ SISYPHUS_SNAPSHOTS_BUCKET: '' })

    await expect(importEnv()).rejects.toThrow('SISYPHUS_SNAPSHOTS_BUCKET')
  })

  it('exposes no job configuration, even when the process environment carries some', async () => {
    stubEnvironment()
    vi.stubEnv('SISYPHUS_WORKFLOW_ID', 'wf_01H8')
    vi.stubEnv('SISYPHUS_SCOPED_CREDENTIAL', 'a-credential')

    const { env } = await importEnv()

    expect(Object.keys(env)).not.toContain('SISYPHUS_WORKFLOW_ID')
    expect(Object.keys(env)).not.toContain('SISYPHUS_SCOPED_CREDENTIAL')
  })

  it('skips validation entirely when SKIP_ENV_VALIDATION is set', async () => {
    vi.stubEnv('SKIP_ENV_VALIDATION', 'true')

    await expect(importEnv()).resolves.toHaveProperty('env')
  })
})
