import { describe, expect, it } from 'vitest'

import { DEFAULT_AWS_REGION, DEPLOY_STAGES, buildSstApp, isDeployStage } from './sst-app'

describe('isDeployStage', () => {
  it('recognises only the two branch-gated stages', () => {
    expect(DEPLOY_STAGES).toEqual(['production', 'staging'])
    expect(isDeployStage('production')).toBe(true)
    expect(isDeployStage('staging')).toBe(true)
    expect(isDeployStage('harry')).toBe(false)
    expect(isDeployStage('production-bootstrap')).toBe(false)
  })
})

describe('buildSstApp', () => {
  it('retains a deploy stage and removes a personal one', () => {
    expect(buildSstApp({ appName: 'sisyphus-admin', sstStage: 'production' }).removal).toBe(
      'retain',
    )
    expect(buildSstApp({ appName: 'sisyphus-admin', sstStage: 'staging' }).removal).toBe('retain')
    expect(buildSstApp({ appName: 'sisyphus-admin', sstStage: 'harry' }).removal).toBe('remove')
  })

  it('protects production alone', () => {
    expect(buildSstApp({ appName: 'sisyphus-admin', sstStage: 'production' }).protect).toBe(true)
    expect(buildSstApp({ appName: 'sisyphus-admin', sstStage: 'staging' }).protect).toBe(false)
  })

  it('decides from the plain stage, so an auxiliary stage is as protected as its parent', () => {
    const bootstrap = buildSstApp({ appName: 'sisyphus-admin', sstStage: 'production-bootstrap' })

    expect(bootstrap.removal).toBe('retain')
    expect(bootstrap.protect).toBe(true)
  })

  it('gives the three deployables the same policy for the same stage', () => {
    const stages = ['production', 'staging', 'harry']

    for (const sstStage of stages) {
      const panel = buildSstApp({ appName: 'sisyphus-admin', sstStage })
      const executor = buildSstApp({ appName: 'sisyphus-executor', sstStage })

      expect(executor.removal).toBe(panel.removal)
      expect(executor.protect).toBe(panel.protect)
    }
  })

  it('defaults the region to the one the deploy workflow falls back to', () => {
    expect(
      buildSstApp({ appName: 'sisyphus-admin', sstStage: 'staging' }).providers.aws.region,
    ).toBe(DEFAULT_AWS_REGION)
    expect(
      buildSstApp({ appName: 'sisyphus-admin', sstStage: 'staging', region: 'eu-west-1' }).providers
        .aws.region,
    ).toBe('eu-west-1')
  })

  it('keeps the SST app name, which is not the resource-name prefix', () => {
    expect(buildSstApp({ appName: 'sisyphus-executor', sstStage: 'staging' }).name).toBe(
      'sisyphus-executor',
    )
  })

  it('refuses an empty app name', () => {
    expect(() => buildSstApp({ appName: '  ', sstStage: 'staging' })).toThrow('without an app name')
  })
})
