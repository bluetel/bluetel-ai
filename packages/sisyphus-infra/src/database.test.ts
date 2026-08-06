import { describe, expect, it } from 'vitest'

import {
  buildDatabaseSpecification,
  createDatabase,
  getConnectionUrlParameterName,
  type DatabaseSpecification,
  type ParameterSpecification,
} from './database'
import { getPlainStage } from './get-plain-stage'

const scope = { project: 'sisyphus', stack: 'staging' }

describe('getConnectionUrlParameterName', () => {
  it('namespaces the parameter under the stage', () => {
    expect(getConnectionUrlParameterName('staging')).toBe(
      '/sisyphus/staging/database/connection-url',
    )
  })

  it('resolves to the same path from an auxiliary stage, via getPlainStage', () => {
    expect(getConnectionUrlParameterName(getPlainStage('staging-website'))).toBe(
      getConnectionUrlParameterName(getPlainStage('staging-bootstrap')),
    )
  })
})

describe('buildDatabaseSpecification', () => {
  it('is always encrypted and never publicly reachable', () => {
    for (const stage of ['production', 'staging', 'dev-harry']) {
      const specification = buildDatabaseSpecification({ scope, stage })

      expect(specification.storageEncrypted).toBe(true)
      expect(specification.publiclyAccessible).toBe(false)
    }
  })

  it('gives production a standby, a fortnight of backups and deletion protection', () => {
    const specification = buildDatabaseSpecification({
      scope: { project: 'sisyphus', stack: 'production' },
      stage: 'production',
    })

    expect(specification.multiAvailabilityZone).toBe(true)
    expect(specification.backupRetentionDays).toBe(14)
    expect(specification.deletionProtection).toBe(true)
  })

  it('leaves a non-production stage disposable', () => {
    const specification = buildDatabaseSpecification({ scope, stage: 'staging' })

    expect(specification.multiAvailabilityZone).toBe(false)
    expect(specification.deletionProtection).toBe(false)
  })

  it('names the instance under the stage-scoped identifier', () => {
    expect(buildDatabaseSpecification({ scope, stage: 'staging' }).identifier).toBe(
      'sisyphus-staging-database',
    )
  })

  it('accepts explicit sizing overrides', () => {
    const specification = buildDatabaseSpecification({
      scope,
      stage: 'staging',
      instanceClass: 'db.m7g.large',
      allocatedStorageGb: 200,
      engineVersion: '16.6',
    })

    expect(specification.instanceClass).toBe('db.m7g.large')
    expect(specification.allocatedStorageGb).toBe(200)
    expect(specification.engineVersion).toBe('16.6')
  })
})

describe('createDatabase', () => {
  it('creates the instance and publishes its URL as a secure parameter', () => {
    const instances: DatabaseSpecification[] = []
    const parameters: ParameterSpecification<string>[] = []

    const created = createDatabase<{ endpoint: string }, { arn: string }, string>(
      {
        createInstance: (_name, specification) => {
          instances.push(specification)

          return { endpoint: 'db.internal:5432' }
        },
        createParameter: (_name, specification) => {
          parameters.push(specification)

          return { arn: specification.name }
        },
      },
      { scope, stage: 'staging' },
      (instance) => `postgres://sisyphus@${instance.endpoint}/sisyphus`,
    )

    expect(instances).toHaveLength(1)
    expect(parameters[0]?.type).toBe('SecureString')
    expect(parameters[0]?.name).toBe('/sisyphus/staging/database/connection-url')
    expect(parameters[0]?.value).toBe('postgres://sisyphus@db.internal:5432/sisyphus')
    expect(created.specification.identifier).toBe('sisyphus-staging-database')
  })

  it('derives the connection URL from the created instance, not from configuration', () => {
    let sawInstance: unknown = null

    createDatabase(
      {
        createInstance: () => ({ endpoint: 'resolved-at-deploy-time' }),
        createParameter: (_name, specification) => specification,
      },
      { scope, stage: 'staging' },
      (instance) => {
        sawInstance = instance

        return instance.endpoint
      },
    )

    expect(sawInstance).toEqual({ endpoint: 'resolved-at-deploy-time' })
  })
})
