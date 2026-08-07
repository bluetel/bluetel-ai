import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Exercises the `runtimeEnv` wiring rather than the process environment: a key
 * declared in the schema but omitted from the explicit map is the failure the
 * map itself introduces, and it only shows up at boot.
 */
const completeEnvironment: Readonly<Record<string, string>> = {
  DATABASE_URL: 'postgres://sisyphus@db.internal:5432/sisyphus',
  SISYPHUS_BOOTSTRAP_ADMIN_EMAILS: 'ht@bluetel.co.uk',
  SISYPHUS_MACHINE_SURFACE_URL: 'https://sisyphus.example.com/api/machine',
  SISYPHUS_MACHINE_CREDENTIAL_SECRET: 'machine-secret',
  SISYPHUS_LOGS_BUCKET: 'sisyphus-staging-logs',
  SISYPHUS_SNAPSHOTS_BUCKET: 'sisyphus-staging-snapshots',
  SISYPHUS_BUNDLES_BUCKET: 'sisyphus-staging-bundles',
  SISYPHUS_ARTIFACTS_BUCKET: 'sisyphus-staging-artifacts',
  SISYPHUS_SCHEDULE_GROUP_NAME: 'sisyphus-staging-schedules',
  SISYPHUS_SCHEDULER_TARGET_ARN: 'arn:aws:lambda:eu-west-2:123456789012:function:control-plane',
  SISYPHUS_SCHEDULER_ROLE_ARN: 'arn:aws:iam::123456789012:role/scheduler',
  SISYPHUS_EXECUTOR_AMI_ID: 'ami-0123456789abcdef0',
  SISYPHUS_EXECUTOR_INSTANCE_PROFILE_ARN:
    'arn:aws:iam::123456789012:instance-profile/executor-runner',
  SISYPHUS_EXECUTOR_SUBNET_IDS: 'subnet-a,subnet-b',
  SISYPHUS_EXECUTOR_SECURITY_GROUP_IDS: 'sg-a',
  SISYPHUS_SLACK_BOT_TOKEN: 'slack-bot-token',
  SISYPHUS_PANEL_URL: 'https://sisyphus.example.com',
  SISYPHUS_STAGE: 'staging',
}

const stubEnvironment = (overrides: Readonly<Record<string, string>> = {}): void => {
  vi.stubEnv('SKIP_ENV_VALIDATION', '')
  vi.stubEnv('AWS_REGION', '')

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
    expect(env.SISYPHUS_SNAPSHOTS_BUCKET).toBe('sisyphus-staging-snapshots')
    expect(env.SISYPHUS_EXECUTOR_SUBNET_IDS).toEqual(['subnet-a', 'subnet-b'])
    expect(env.AWS_REGION).toBe('eu-west-2')
  })

  it('exposes the bootstrap admin list as parsed addresses', async () => {
    stubEnvironment({ SISYPHUS_BOOTSTRAP_ADMIN_EMAILS: 'HT@bluetel.co.uk, second@bluetel.co.uk' })

    const { env } = await importEnv()

    expect(env.SISYPHUS_BOOTSTRAP_ADMIN_EMAILS).toEqual([
      'ht@bluetel.co.uk',
      'second@bluetel.co.uk',
    ])
  })

  it('refuses to boot without a bootstrap admin, naming the variable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    stubEnvironment({ SISYPHUS_BOOTSTRAP_ADMIN_EMAILS: '' })

    await expect(importEnv()).rejects.toThrow('SISYPHUS_BOOTSTRAP_ADMIN_EMAILS')
  })

  it('fails at import naming a missing bucket, rather than yielding undefined', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    stubEnvironment({ SISYPHUS_SNAPSHOTS_BUCKET: '' })

    await expect(importEnv()).rejects.toThrow('SISYPHUS_SNAPSHOTS_BUCKET')
  })

  it('skips validation entirely when SKIP_ENV_VALIDATION is set', async () => {
    vi.stubEnv('SKIP_ENV_VALIDATION', 'true')

    await expect(importEnv()).resolves.toHaveProperty('env')
  })
})
