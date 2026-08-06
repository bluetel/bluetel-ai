import { describe, expect, it } from 'vitest'

import { clientSchemas, processEnvKeys, serverSchemas } from './env-schemas'

describe('SISYPHUS_BOOTSTRAP_ADMIN_EMAILS', () => {
  const schema = serverSchemas.SISYPHUS_BOOTSTRAP_ADMIN_EMAILS

  it('parses a single address', () => {
    expect(schema.parse('ht@bluetel.co.uk')).toEqual(['ht@bluetel.co.uk'])
  })

  it('parses a comma-separated list, trimming and lower-casing', () => {
    expect(schema.parse('HT@Bluetel.co.uk , second@bluetel.co.uk')).toEqual([
      'ht@bluetel.co.uk',
      'second@bluetel.co.uk',
    ])
  })

  it('drops the empty entry left by a trailing comma', () => {
    expect(schema.parse('ht@bluetel.co.uk,')).toEqual(['ht@bluetel.co.uk'])
  })

  it('rejects a value that is not an email address', () => {
    expect(() => schema.parse('ht')).toThrow()
    expect(() => schema.parse('ht@bluetel.co.uk,not-an-email')).toThrow()
  })

  it('is required, because without it there is no admin and nothing can be configured', () => {
    expect(() => schema.parse(undefined)).toThrow()
  })

  it('rejects a list that resolves to no addresses at all', () => {
    expect(() => schema.parse(', ,')).toThrow()
  })
})

describe('serverSchemas', () => {
  it('requires the database URL', () => {
    expect(() => serverSchemas.DATABASE_URL.parse(undefined)).toThrow()
    expect(() => serverSchemas.DATABASE_URL.parse('localhost')).toThrow()
  })

  it('requires all four bucket names, since teardown verifies durability across every class', () => {
    for (const key of [
      'SISYPHUS_LOGS_BUCKET',
      'SISYPHUS_SNAPSHOTS_BUCKET',
      'SISYPHUS_BUNDLES_BUCKET',
      'SISYPHUS_ARTIFACTS_BUCKET',
    ] as const) {
      expect(() => serverSchemas[key].parse(undefined)).toThrow()
      expect(serverSchemas[key].parse('a-bucket')).toBe('a-bucket')
    }
  })

  it('requires the machine surface URL and the credential-minting key', () => {
    expect(() => serverSchemas.SISYPHUS_MACHINE_SURFACE_URL.parse('not-a-url')).toThrow()
    expect(() => serverSchemas.SISYPHUS_MACHINE_CREDENTIAL_SECRET.parse(undefined)).toThrow()
  })

  it('requires the scheduler wiring, so an enabled integration cannot fail to register', () => {
    expect(() => serverSchemas.SISYPHUS_SCHEDULE_GROUP_NAME.parse(undefined)).toThrow()
    expect(() => serverSchemas.SISYPHUS_SCHEDULER_TARGET_ARN.parse(undefined)).toThrow()
    expect(() => serverSchemas.SISYPHUS_SCHEDULER_ROLE_ARN.parse(undefined)).toThrow()
  })

  it('requires the Slack bot token — the only notification channel in scope', () => {
    expect(() => serverSchemas.SISYPHUS_SLACK_BOT_TOKEN.parse(undefined)).toThrow()
  })

  it('parses the executor network placement as lists', () => {
    expect(serverSchemas.SISYPHUS_EXECUTOR_SUBNET_IDS.parse('subnet-a, subnet-b')).toEqual([
      'subnet-a',
      'subnet-b',
    ])
    expect(serverSchemas.SISYPHUS_EXECUTOR_SECURITY_GROUP_IDS.parse('sg-a')).toEqual(['sg-a'])
    expect(() => serverSchemas.SISYPHUS_EXECUTOR_SUBNET_IDS.parse(',')).toThrow()
  })

  it('defaults the region', () => {
    expect(serverSchemas.AWS_REGION.parse(undefined)).toBe('eu-west-2')
  })
})

describe('the client schema', () => {
  it('is empty — the control plane has no browser bundle and no inbound surface', () => {
    expect(Object.keys(clientSchemas)).toEqual([])
  })

  it('declares no NEXT_PUBLIC_ variable anywhere', () => {
    for (const key of Object.keys(serverSchemas)) {
      expect(key.startsWith('NEXT_PUBLIC_')).toBe(false)
    }
  })
})

describe('processEnvKeys', () => {
  it('marks every server key secret', () => {
    expect(processEnvKeys.every((entry) => entry.secret)).toBe(true)
    expect(processEnvKeys.map((entry) => entry.key)).toEqual(Object.keys(serverSchemas))
  })
})
