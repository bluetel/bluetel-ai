/**
 * EventBridge Scheduler: one schedule group per stage, plus the control-plane
 * tick inside it.
 *
 * Every schedule targets the control plane, which has no inbound network surface
 * (FR-035) — Scheduler invokes it directly, so no endpoint is introduced to make
 * scheduling work. The tick drives admission, queue draining, admin bootstrap
 * and reconciliation: the jobs the panel cannot invoke.
 *
 * Per-integration schedules are **not** created here. The control plane creates
 * and removes them at runtime whenever an integration's expression or enabled
 * state changes (FR-100), which is also why they are one schedule per
 * integration rather than a single sweep: a sweep lets one slow connector starve
 * every other board, and makes per-integration coalescing bookkeeping rather
 * than a property of the scheduler. What this module provisions is the group
 * they live in and the tick that never changes.
 */

import type { ResourceScope } from './lib'
import { getControlPlaneTickName, getSchedulerGroupName } from './schedule-name'

/** The payload the tick carries, and what `dispatch` routes on. */
export const CONTROL_PLANE_TICK_JOB = 'control-plane-tick'

const DEFAULT_TICK_EXPRESSION = 'rate(1 minute)'

const DEFAULT_TIMEZONE = 'Etc/UTC'

export interface ScheduleTargetConfig {
  /** ARN of the control-plane function every schedule invokes. */
  readonly functionArn: string
  /** Role EventBridge Scheduler assumes in order to invoke that function. */
  readonly roleArn: string
}

export interface SchedulerConfig {
  readonly scope: ResourceScope
  readonly target: ScheduleTargetConfig
  readonly tickExpression?: string
}

export interface Scheduler {
  /** The group the control plane registers per-integration schedules into. */
  readonly groupName: string
  readonly group: aws.scheduler.ScheduleGroup
  readonly controlPlaneTick: aws.scheduler.Schedule
}

export const createScheduler = (config: SchedulerConfig): Scheduler => {
  const groupName = getSchedulerGroupName(config.scope)

  const group = new aws.scheduler.ScheduleGroup(groupName, { name: groupName })

  const tickName = getControlPlaneTickName(config.scope)

  const controlPlaneTick = new aws.scheduler.Schedule(tickName, {
    name: tickName,
    groupName,
    scheduleExpression: config.tickExpression ?? DEFAULT_TICK_EXPRESSION,
    scheduleExpressionTimezone: DEFAULT_TIMEZONE,
    // Never flexible. A window would let two ticks drift together, and FR-103's
    // coalescing assumes ticks arrive at a predictable cadence.
    flexibleTimeWindow: { mode: 'OFF' },
    state: 'ENABLED',
    target: {
      arn: config.target.functionArn,
      roleArn: config.target.roleArn,
      // Named in the payload so one target can fan out; `dispatch` parses it.
      input: JSON.stringify({ job: CONTROL_PLANE_TICK_JOB }),
    },
  })

  return { groupName, group, controlPlaneTick }
}
