import { describe, expect, it } from 'vitest'

import {
  buildControlPlaneTickSpecification,
  buildIntegrationScheduleName,
  buildIntegrationScheduleSpecification,
  buildSchedulerGroupSpecification,
  createScheduler,
  toScheduleName,
} from './scheduler'

const scope = { project: 'sisyphus', stack: 'staging' }

const target = {
  functionArn: 'arn:aws:lambda:eu-west-2:123456789012:function:sisyphus-staging-control-plane',
  roleArn: 'arn:aws:iam::123456789012:role/sisyphus-staging-scheduler',
}

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

describe('buildSchedulerGroupSpecification', () => {
  it('names one group per stage', () => {
    expect(buildSchedulerGroupSpecification(scope).name).toBe('sisyphus-staging-schedules')
  })
})

describe('buildIntegrationScheduleName', () => {
  it('derives the name from the integration id, so re-registration is an upsert', () => {
    expect(buildIntegrationScheduleName(scope, 'int_42')).toBe(
      'sisyphus-staging-integration-int_42',
    )
  })

  it('gives two integrations two distinct schedules', () => {
    expect(buildIntegrationScheduleName(scope, 'int_1')).not.toBe(
      buildIntegrationScheduleName(scope, 'int_2'),
    )
  })
})

describe('buildIntegrationScheduleSpecification', () => {
  const specification = buildIntegrationScheduleSpecification({
    scope,
    groupName: 'sisyphus-staging-schedules',
    integrationId: 'int_42',
    scheduleExpression: 'rate(5 minutes)',
    enabled: true,
    target,
  })

  it('targets the control plane with the integration named in the payload', () => {
    expect(specification.target.arn).toBe(target.functionArn)
    expect(JSON.parse(specification.target.input)).toEqual({
      job: 'integration-tick',
      integrationId: 'int_42',
    })
  })

  it('never uses a flexible time window', () => {
    expect(specification.flexibleTimeWindowMode).toBe('OFF')
  })

  it('defaults to UTC', () => {
    expect(specification.scheduleExpressionTimezone).toBe('Etc/UTC')
  })

  it('honours an explicit timezone', () => {
    const localised = buildIntegrationScheduleSpecification({
      scope,
      groupName: 'sisyphus-staging-schedules',
      integrationId: 'int_42',
      scheduleExpression: 'cron(0 9 * * ? *)',
      timezone: 'Europe/London',
      enabled: true,
      target,
    })

    expect(localised.scheduleExpressionTimezone).toBe('Europe/London')
  })

  it('keeps a disabled integration’s schedule, disabled', () => {
    const disabled = buildIntegrationScheduleSpecification({
      scope,
      groupName: 'sisyphus-staging-schedules',
      integrationId: 'int_42',
      scheduleExpression: 'rate(5 minutes)',
      enabled: false,
      target,
    })

    expect(disabled.state).toBe('DISABLED')
    expect(disabled.name).toBe(specification.name)
  })
})

describe('buildControlPlaneTickSpecification', () => {
  const specification = buildControlPlaneTickSpecification({
    scope,
    groupName: 'sisyphus-staging-schedules',
    target,
  })

  it('runs every minute by default', () => {
    expect(specification.scheduleExpression).toBe('rate(1 minute)')
  })

  it('names its job in the payload so one target can fan out', () => {
    expect(JSON.parse(specification.target.input)).toEqual({ job: 'control-plane-tick' })
  })

  it('is enabled and inflexible', () => {
    expect(specification.state).toBe('ENABLED')
    expect(specification.flexibleTimeWindowMode).toBe('OFF')
  })
})

describe('createScheduler', () => {
  it('creates the group and the tick inside it', () => {
    const created = createScheduler(
      {
        createScheduleGroup: (name) => ({ kind: 'group' as const, name }),
        createSchedule: (name, specification) => ({
          kind: 'schedule' as const,
          name,
          groupName: specification.groupName,
        }),
      },
      { scope, target },
    )

    expect(created.group.name).toBe('sisyphus-staging-schedules')
    expect(created.controlPlaneTick.groupName).toBe('sisyphus-staging-schedules')
    expect(created.controlPlaneTick.name).toBe('sisyphus-staging-control-plane-tick')
  })
})
