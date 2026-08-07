import { describe, expect, it } from 'vitest'

import {
  getControlPlaneTickName,
  getIntegrationScheduleName,
  getSchedulerGroupName,
  toScheduleName,
} from './schedule-name'

const scope = { project: 'sisyphus', stack: 'staging' }

describe('toScheduleName', () => {
  it('passes a legal name through unchanged', () => {
    expect(toScheduleName('sisyphus-staging-integration-abc')).toBe(
      'sisyphus-staging-integration-abc',
    )
  })

  it('replaces characters EventBridge Scheduler rejects', () => {
    expect(toScheduleName('sisyphus/staging integration:1')).toBe('sisyphus-staging-integration-1')
  })

  it('refuses an empty identifier', () => {
    expect(() => toScheduleName('')).toThrow('empty identifier')
  })

  it('refuses to truncate an over-long name, because a collision silently stops polling', () => {
    expect(() => toScheduleName('a'.repeat(65))).toThrow('exceeds the 64-character limit')
  })

  it('accepts a name at exactly the limit', () => {
    expect(toScheduleName('a'.repeat(64))).toHaveLength(64)
  })
})

describe('getSchedulerGroupName', () => {
  it('names one group per stage', () => {
    expect(getSchedulerGroupName(scope)).toBe('sisyphus-staging-schedules')
  })

  it('isolates two stages sharing an account', () => {
    expect(getSchedulerGroupName({ project: 'sisyphus', stack: 'production' })).not.toBe(
      getSchedulerGroupName(scope),
    )
  })
})

describe('getControlPlaneTickName', () => {
  it('names the stage tick under the stage', () => {
    expect(getControlPlaneTickName(scope)).toBe('sisyphus-staging-control-plane-tick')
  })
})

describe('getIntegrationScheduleName', () => {
  it('derives the name from the integration id, so re-registration is an upsert', () => {
    expect(getIntegrationScheduleName(scope, 'int_42')).toBe('sisyphus-staging-integration-int_42')
  })

  it('gives two integrations two distinct schedules', () => {
    expect(getIntegrationScheduleName(scope, 'int_1')).not.toBe(
      getIntegrationScheduleName(scope, 'int_2'),
    )
  })

  it('refuses an integration id that would produce a colliding truncated name', () => {
    expect(() => getIntegrationScheduleName(scope, 'x'.repeat(64))).toThrow(
      'exceeds the 64-character limit',
    )
  })
})
