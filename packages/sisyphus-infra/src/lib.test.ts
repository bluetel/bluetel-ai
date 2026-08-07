import { describe, expect, it, vi } from 'vitest'

import { getPlainStage } from './get-plain-stage'
import {
  POLICY_VERSION,
  SISYPHUS_PROJECT,
  getBucketName,
  getBucketNames,
  getConnectionUrlParameterName,
  getEnvSecret,
  getResourceIdentifier,
  getStackScope,
  readEnvRecord,
} from './lib'

describe('getResourceIdentifier', () => {
  it('formats as {project}-{stack}-{name}', () => {
    expect(getResourceIdentifier({ project: 'sisyphus', stack: 'staging' }, 'logs')).toBe(
      'sisyphus-staging-logs',
    )
  })

  it('keeps auxiliary stage suffixes, so a bootstrap stage names distinct resources', () => {
    expect(
      getResourceIdentifier({ project: 'sisyphus', stack: 'production-bootstrap' }, 'github-oidc'),
    ).toBe('sisyphus-production-bootstrap-github-oidc')
  })

  it('isolates two stages of the same project by name', () => {
    const staging = getResourceIdentifier({ project: 'sisyphus', stack: 'staging' }, 'snapshots')
    const production = getResourceIdentifier(
      { project: 'sisyphus', stack: 'production' },
      'snapshots',
    )

    expect(staging).not.toBe(production)
  })
})

describe('getStackScope', () => {
  it('names resources under the shared project rather than the deployable', () => {
    expect(getStackScope('staging')).toEqual({ project: SISYPHUS_PROJECT, stack: 'staging' })
  })

  it('collapses every auxiliary stage onto its plain stage', () => {
    expect(getStackScope('production-bootstrap').stack).toBe('production')
    expect(getStackScope('production-website').stack).toBe('production')
    expect(getStackScope('production').stack).toBe('production')
  })

  it('gives the three deployables the same name for a shared resource', () => {
    const fromPanel = getResourceIdentifier(getStackScope('production-website'), 'artifacts')
    const fromControlPlane = getResourceIdentifier(getStackScope('production'), 'artifacts')

    expect(fromPanel).toBe('sisyphus-production-artifacts')
    expect(fromControlPlane).toBe(fromPanel)
  })

  it('refuses an empty stage rather than naming resources "sisyphus--artifacts"', () => {
    expect(() => getStackScope('')).toThrow('empty stage name')
    expect(() => getStackScope('   ')).toThrow('empty stage name')
  })
})

describe('getBucketName', () => {
  it('names each class of object under the stage', () => {
    const scope = getStackScope('staging')

    expect(getBucketName(scope, 'logs')).toBe('sisyphus-staging-logs')
    expect(getBucketName(scope, 'snapshots')).toBe('sisyphus-staging-snapshots')
  })

  it('gives the creating stack and the deriving stacks the same name', () => {
    expect(getBucketName(getStackScope('production-website'), 'bundles')).toBe(
      getBucketName(getStackScope('production'), 'bundles'),
    )
  })
})

describe('getBucketNames', () => {
  it('answers for all four classes, each distinct', () => {
    const names = getBucketNames(getStackScope('staging'))

    expect(names).toEqual({
      artifacts: 'sisyphus-staging-artifacts',
      bundles: 'sisyphus-staging-bundles',
      logs: 'sisyphus-staging-logs',
      snapshots: 'sisyphus-staging-snapshots',
    })
    expect(new Set(Object.values(names)).size).toBe(4)
  })
})

describe('getConnectionUrlParameterName', () => {
  it('namespaces the parameter under the stage', () => {
    expect(getConnectionUrlParameterName('staging')).toBe(
      '/sisyphus/staging/database/connection-url',
    )
  })

  it('resolves to the same path from every auxiliary stage', () => {
    expect(getConnectionUrlParameterName('staging-website')).toBe(
      getConnectionUrlParameterName('staging-bootstrap'),
    )
    expect(getConnectionUrlParameterName(getPlainStage('staging-website'))).toBe(
      getConnectionUrlParameterName('staging'),
    )
  })
})

describe('getEnvSecret', () => {
  const wrap = (value: string) => ({ wrapped: value })

  it('wraps the value by default so it is not stored in plain text', () => {
    expect(getEnvSecret(wrap, { DATABASE_URL: 'postgres://x' }, 'DATABASE_URL')).toEqual({
      wrapped: 'postgres://x',
    })
  })

  it('returns the raw value when clear text is explicitly requested', () => {
    const wrapSecret = vi.fn(wrap)

    const value = getEnvSecret(wrapSecret, { STAGE: 'staging' }, 'STAGE', {
      dangerousClearText: true,
    })

    expect(value).toBe('staging')
    expect(wrapSecret).not.toHaveBeenCalled()
  })

  it('throws naming the missing variable', () => {
    expect(() => getEnvSecret(wrap, {} as Record<'AUTH_SECRET', string>, 'AUTH_SECRET')).toThrow(
      'Missing environment variable: AUTH_SECRET',
    )
  })

  it('treats an empty string as missing rather than passing it to a resource argument', () => {
    expect(() => getEnvSecret(wrap, { AUTH_SECRET: '' }, 'AUTH_SECRET')).toThrow(
      'Missing environment variable: AUTH_SECRET',
    )
  })
})

describe('readEnvRecord', () => {
  it('keeps the values that are set', () => {
    expect(readEnvRecord({ AUTH_SECRET: 'shh', AWS_REGION: 'eu-west-2' })).toEqual({
      AUTH_SECRET: 'shh',
      AWS_REGION: 'eu-west-2',
    })
  })

  it('drops unset keys so the missing-variable error names them', () => {
    const record = readEnvRecord({ AUTH_SECRET: undefined })

    expect(Object.keys(record)).toEqual([])
    expect(() => getEnvSecret((value: string) => value, record, 'AUTH_SECRET')).toThrow(
      'Missing environment variable: AUTH_SECRET',
    )
  })

  it('keeps an empty value, which getEnvSecret rejects on its own terms', () => {
    expect(readEnvRecord({ AUTH_SECRET: '' })).toEqual({ AUTH_SECRET: '' })
  })
})

describe('POLICY_VERSION', () => {
  it('is the only version AWS accepts for new policies', () => {
    expect(POLICY_VERSION).toBe('2012-10-17')
  })
})
