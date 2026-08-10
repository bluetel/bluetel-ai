import { describe, expect, it } from 'vitest'

import {
  REQUIRED_EXECUTOR_STAGE_URLS,
  buildExecutorInstanceEnvironment,
  formatExecutorInstanceEnvironment,
  getExecutorInstanceEnvironmentParameterName,
} from './executor-instance-environment'
import { getBucketNames, getStackScope } from './lib'
import { parseEnvContent } from './scripts/get-deployment-environment'

const configuration = {
  SISYPHUS_MACHINE_SURFACE_URL: 'https://sisyphus.bluetel.co.uk/api/machine',
  SISYPHUS_FORGE_API_URL: 'https://api.github.com',
}

const config = {
  region: 'eu-west-2',
  stage: 'staging',
  buckets: getBucketNames(getStackScope('staging')),
  configuration,
}

describe('getExecutorInstanceEnvironmentParameterName', () => {
  it('sits beside the stage’s other executor parameters', () => {
    expect(getExecutorInstanceEnvironmentParameterName('staging')).toBe(
      '/sisyphus/staging/executor/instance-environment',
    )
  })

  it('resolves the same entry from every auxiliary stage suffix', () => {
    const plain = getExecutorInstanceEnvironmentParameterName('production')

    expect(getExecutorInstanceEnvironmentParameterName('production-bootstrap')).toBe(plain)
    expect(getExecutorInstanceEnvironmentParameterName('production-website')).toBe(plain)
  })

  it('isolates one stage from another', () => {
    expect(getExecutorInstanceEnvironmentParameterName('staging')).not.toBe(
      getExecutorInstanceEnvironmentParameterName('production'),
    )
  })
})

describe('buildExecutorInstanceEnvironment', () => {
  it('produces every value the executor requires at boot', () => {
    // The keys `apps/sisyphus-executor/src/env-schemas.ts` declares without a default. This list is
    // the contract between the two files; a variable added there without being added here is an
    // instance that boots and dies naming it.
    expect(Object.keys(buildExecutorInstanceEnvironment(config)).sort()).toEqual([
      'AWS_REGION',
      'SISYPHUS_ARTIFACTS_BUCKET',
      'SISYPHUS_BUNDLES_BUCKET',
      'SISYPHUS_FORGE_API_URL',
      'SISYPHUS_LOGS_BUCKET',
      'SISYPHUS_MACHINE_SURFACE_URL',
      'SISYPHUS_SNAPSHOTS_BUCKET',
      'SISYPHUS_STAGE',
    ])
  })

  it('carries the forge API base, which is what T238 gave a producer', () => {
    expect(buildExecutorInstanceEnvironment(config).SISYPHUS_FORGE_API_URL).toBe(
      'https://api.github.com',
    )
  })

  it('takes bucket names from the stage scope rather than from the configuration blob', () => {
    const built = buildExecutorInstanceEnvironment({
      ...config,
      configuration: { ...configuration, SISYPHUS_BUNDLES_BUCKET: 'somebody-typed-this' },
    })

    expect(built.SISYPHUS_BUNDLES_BUCKET).toBe('sisyphus-staging-bundles')
  })

  it('never emits SISYPHUS_WORKSPACE_ROOT, which is pinned at the executor (FR-051)', () => {
    expect(buildExecutorInstanceEnvironment(config)).not.toHaveProperty('SISYPHUS_WORKSPACE_ROOT')
  })

  it.each(REQUIRED_EXECUTOR_STAGE_URLS)('refuses a stage with no %s, naming it', (key) => {
    const rest = Object.fromEntries(Object.entries(configuration).filter(([name]) => name !== key))

    expect(() => buildExecutorInstanceEnvironment({ ...config, configuration: rest })).toThrow(key)
  })

  it.each(REQUIRED_EXECUTOR_STAGE_URLS)('refuses a blank %s rather than publishing it', (key) => {
    expect(() =>
      buildExecutorInstanceEnvironment({
        ...config,
        configuration: { ...configuration, [key]: '   ' },
      }),
    ).toThrow(key)
  })

  it.each(REQUIRED_EXECUTOR_STAGE_URLS)('refuses a %s with no scheme', (key) => {
    expect(() =>
      buildExecutorInstanceEnvironment({
        ...config,
        configuration: { ...configuration, [key]: 'api.forge.example' },
      }),
    ).toThrow(/not a URL/)
  })

  it.each(REQUIRED_EXECUTOR_STAGE_URLS)('refuses a %s the executor could not fetch', (key) => {
    expect(() =>
      buildExecutorInstanceEnvironment({
        ...config,
        configuration: { ...configuration, [key]: 'ftp://api.forge.example' },
      }),
    ).toThrow(/scheme/)
  })

  it('trims a value an operator left padded', () => {
    expect(
      buildExecutorInstanceEnvironment({
        ...config,
        configuration: { ...configuration, SISYPHUS_FORGE_API_URL: '  https://api.github.com  ' },
      }).SISYPHUS_FORGE_API_URL,
    ).toBe('https://api.github.com')
  })
})

describe('formatExecutorInstanceEnvironment', () => {
  it('round-trips through the parser the deploy path already uses', () => {
    const built = buildExecutorInstanceEnvironment(config)

    expect(parseEnvContent(formatExecutorInstanceEnvironment(built))).toEqual(built)
  })

  it('ends with a newline, so a shell reading the last line reads a complete one', () => {
    expect(formatExecutorInstanceEnvironment(buildExecutorInstanceEnvironment(config))).toMatch(
      /\n$/,
    )
  })
})
