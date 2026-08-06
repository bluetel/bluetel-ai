/**
 * EventBridge Scheduler: one schedule group per stage, one schedule per enabled
 * integration, plus the control-plane tick.
 *
 * One schedule per integration rather than a single sweep, because a sweep lets
 * one slow or hanging connector starve every other board, and makes
 * per-integration coalescing bookkeeping rather than a property of the
 * scheduler. Every schedule targets the control plane, which has no inbound
 * network surface (FR-035) — Scheduler invokes it directly, so no endpoint is
 * introduced to make scheduling work.
 */

import { getResourceIdentifier, type ResourceScope } from './lib'

/** EventBridge Scheduler accepts `[0-9a-zA-Z-_.]` and caps names at 64 characters. */
const SCHEDULE_NAME_MAX_LENGTH = 64
const DISALLOWED_NAME_CHARACTERS = /[^0-9a-zA-Z\-_.]/g

/**
 * Coerces an arbitrary identifier into a legal schedule name, and refuses
 * rather than silently truncating — a truncated name would collide with another
 * integration's schedule and one board would silently stop being polled.
 */
export const toScheduleName = (rawName: string): string => {
  const sanitised = rawName.replace(DISALLOWED_NAME_CHARACTERS, '-')

  if (sanitised === '') {
    throw new Error('Cannot build a schedule name from an empty identifier')
  }

  if (sanitised.length > SCHEDULE_NAME_MAX_LENGTH) {
    throw new Error(
      `Schedule name "${sanitised}" exceeds the ${String(SCHEDULE_NAME_MAX_LENGTH)}-character limit; ` +
        `truncating it would risk colliding with another schedule.`,
    )
  }

  return sanitised
}

export interface SchedulerGroupSpecification {
  readonly name: string
}

export const buildSchedulerGroupSpecification = (
  scope: ResourceScope,
): SchedulerGroupSpecification => ({
  name: toScheduleName(getResourceIdentifier(scope, 'schedules')),
})

export interface ScheduleTarget {
  /** ARN of the control-plane function the schedule invokes. */
  readonly arn: string
  /** Role EventBridge Scheduler assumes in order to invoke the target. */
  readonly roleArn: string
  /** JSON payload handed to the target, naming the job and its subject. */
  readonly input: string
}

export interface ScheduleSpecification {
  readonly name: string
  readonly groupName: string
  readonly scheduleExpression: string
  readonly scheduleExpressionTimezone: string
  /**
   * Always `OFF`. A flexible window would let two ticks for the same
   * integration drift together, and FR-103's coalescing assumes ticks arrive at
   * a predictable cadence.
   */
  readonly flexibleTimeWindowMode: 'OFF'
  readonly state: 'DISABLED' | 'ENABLED'
  readonly target: ScheduleTarget
}

export interface ScheduleTargetConfig {
  readonly functionArn: string
  readonly roleArn: string
}

export interface IntegrationScheduleConfig {
  readonly scope: ResourceScope
  readonly groupName: string
  readonly integrationId: string
  /** `rate(...)` or `cron(...)`, as configured on the integration. */
  readonly scheduleExpression: string
  readonly timezone?: string
  /** A disabled integration keeps its schedule, disabled, so re-enabling is a state change (FR-100). */
  readonly enabled: boolean
  readonly target: ScheduleTargetConfig
}

const DEFAULT_TIMEZONE = 'Etc/UTC'

/**
 * Derives the schedule name from the integration id, so
 * create/update/remove-on-change (FR-100) is an idempotent upsert rather than a
 * lookup by tag.
 */
export const buildIntegrationScheduleName = (scope: ResourceScope, integrationId: string): string =>
  toScheduleName(getResourceIdentifier(scope, `integration-${integrationId}`))

export const buildIntegrationScheduleSpecification = (
  config: IntegrationScheduleConfig,
): ScheduleSpecification => ({
  name: buildIntegrationScheduleName(config.scope, config.integrationId),
  groupName: config.groupName,
  scheduleExpression: config.scheduleExpression,
  scheduleExpressionTimezone: config.timezone ?? DEFAULT_TIMEZONE,
  flexibleTimeWindowMode: 'OFF',
  state: config.enabled ? 'ENABLED' : 'DISABLED',
  target: {
    arn: config.target.functionArn,
    roleArn: config.target.roleArn,
    input: JSON.stringify({ job: 'integration-tick', integrationId: config.integrationId }),
  },
})

export interface ControlPlaneTickConfig {
  readonly scope: ResourceScope
  readonly groupName: string
  readonly scheduleExpression?: string
  readonly target: ScheduleTargetConfig
}

/**
 * The control plane's own tick. It drives admission, queue draining, admin
 * bootstrap and reconciliation — the jobs the panel cannot invoke, because
 * FR-035 leaves the control plane with no inbound network surface.
 */
export const buildControlPlaneTickSpecification = (
  config: ControlPlaneTickConfig,
): ScheduleSpecification => ({
  name: toScheduleName(getResourceIdentifier(config.scope, 'control-plane-tick')),
  groupName: config.groupName,
  scheduleExpression: config.scheduleExpression ?? 'rate(1 minute)',
  scheduleExpressionTimezone: DEFAULT_TIMEZONE,
  flexibleTimeWindowMode: 'OFF',
  state: 'ENABLED',
  target: {
    arn: config.target.functionArn,
    roleArn: config.target.roleArn,
    input: JSON.stringify({ job: 'control-plane-tick' }),
  },
})

/**
 * The narrow slice of the SST/Pulumi provider surface this primitive needs.
 * `sst.config.ts` supplies constructors closing over the real `aws` global.
 */
export interface SchedulerProvider<TGroup, TSchedule> {
  readonly createScheduleGroup: (name: string, specification: SchedulerGroupSpecification) => TGroup
  readonly createSchedule: (name: string, specification: ScheduleSpecification) => TSchedule
}

export interface CreatedScheduler<TGroup, TSchedule> {
  readonly groupSpecification: SchedulerGroupSpecification
  readonly group: TGroup
  readonly controlPlaneTick: TSchedule
}

/**
 * Creates the stage's schedule group and the control-plane tick within it.
 * Per-integration schedules are created at runtime by the control plane
 * whenever an integration's schedule or enabled state changes (FR-100), not at
 * deploy time — which is why only the group and the tick are provisioned here.
 */
export const createScheduler = <TGroup, TSchedule>(
  provider: SchedulerProvider<TGroup, TSchedule>,
  config: { readonly scope: ResourceScope; readonly target: ScheduleTargetConfig },
): CreatedScheduler<TGroup, TSchedule> => {
  const groupSpecification = buildSchedulerGroupSpecification(config.scope)
  const group = provider.createScheduleGroup(groupSpecification.name, groupSpecification)

  const tickSpecification = buildControlPlaneTickSpecification({
    scope: config.scope,
    groupName: groupSpecification.name,
    target: config.target,
  })

  return {
    groupSpecification,
    group,
    controlPlaneTick: provider.createSchedule(tickSpecification.name, tickSpecification),
  }
}
