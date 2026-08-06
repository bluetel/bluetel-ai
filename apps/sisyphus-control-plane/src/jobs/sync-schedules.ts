import type { Integration, SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'
import { integrations } from '@bluetel-ai/sisyphus-api/db'
import { eq } from 'drizzle-orm'

import type { ScheduleDefinition, ScheduleRegistry } from '../aws'

import { listIntegrations } from './integration-store'
import type { JobOutcome } from './run-job'
import { runJob, toError } from './run-job'

/**
 * Keeping registered schedules in lockstep with the rows they came from (T118, FR-099, FR-100,
 * FR-155).
 *
 * ## Desired state, not events
 *
 * The obvious design registers a schedule when an integration is created and removes it when the
 * integration is deleted. It is also the one that breaks: the panel's mutation and the scheduler
 * are two systems, so any write that lands while the scheduler is unreachable leaves a row and a
 * schedule that disagree forever, and nothing ever looks again. The failure is silent in the worse
 * direction — a **disabled integration whose schedule is still firing** keeps starting paid runs.
 *
 * So this is a reconciler. It reads every integration, computes what the group *should* contain,
 * and brings it there: upsert for every enabled row, disable-or-remove for every disabled one, and
 * a sweep for every schedule in the group whose integration no longer exists. Run it after any
 * mutation and on a timer; running it twice changes nothing, which is what makes "run it again"
 * always a safe answer.
 *
 * ## The timezone is the integration's, not the platform's (FR-155)
 *
 * Every schedule carries `ScheduleExpressionTimezone`, so an expression meaning "09:00" fires at
 * 09:00 on **that board's** wall clock, and keeps firing at 09:00 across a daylight-saving
 * transition rather than drifting to 08:00 for half the year. That is the whole reason the column
 * exists, and it is the reason this file never converts anything to UTC: converting would fix the
 * instant and break the wall clock, which is exactly backwards for a schedule an admin wrote
 * against their own working day.
 *
 * ## A disabled integration keeps its schedule, disabled
 *
 * Rather than deleting it. The schedule's history and its target survive, so re-enabling is a flag
 * rather than a re-creation, and an operator looking at the group can see that the integration
 * exists and is off — which a missing schedule cannot say.
 */

export const SYNC_SCHEDULES_JOB_NAME = 'sync-schedules'

/** Prefix on every schedule this platform owns, so a sweep cannot delete somebody else's. */
export const SCHEDULE_NAME_PREFIX = 'sisyphus-integration-'

/**
 * The schedule name for an integration.
 *
 * Derived from the id rather than the name: an integration's name is editable and its id is not, so
 * a rename would otherwise orphan a schedule and register a second one beside it.
 */
export const scheduleNameFor = (integrationId: string): string =>
  `${SCHEDULE_NAME_PREFIX}${integrationId}`

/** The integration id inside a schedule name, or `undefined` if the name is not ours. */
export const integrationIdFromScheduleName = (name: string): string | undefined =>
  name.startsWith(SCHEDULE_NAME_PREFIX) ? name.slice(SCHEDULE_NAME_PREFIX.length) : undefined

/**
 * What EventBridge Scheduler is handed when the tick fires.
 *
 * The payload names the integration **and** the trigger. A target that had to work out which
 * integration fired it from the schedule name would be parsing a string it did not construct.
 */
export const schedulePayloadFor = (integrationId: string): string =>
  JSON.stringify({ job: 'integration-tick', integrationId, trigger: 'scheduled' })

/**
 * A stored cron expression as Scheduler wants it.
 *
 * Admins write five-field cron (`0/15 * * * *`), which is what every scheduling UI and every crontab
 * uses. Scheduler wants six fields wrapped in `cron(...)`, with a year and with the
 * day-of-week/day-of-month `?` convention. Accepting only Scheduler's dialect would make the panel's
 * "raw cron expression as an escape hatch" (FR-154) an expression most people would get wrong; and
 * `rate(...)` is passed through untouched because a rate is already unambiguous.
 *
 * @throws If the expression is neither a supported cron nor a rate. A schedule registered from an
 *   expression nobody could parse would fire at a time nobody chose.
 */
export const toSchedulerExpression = (expression: string): string => {
  const trimmed = expression.trim()

  if (/^(?:cron|rate|at)\(.*\)$/.test(trimmed)) {
    return trimmed
  }

  const fields = trimmed.split(/\s+/)

  if (fields.length === 6) {
    return `cron(${fields.join(' ')})`
  }

  if (fields.length !== 5) {
    throw new Error(
      `Cannot register a schedule from ${expression}: expected five-field cron, a six-field Scheduler cron, or a rate() expression.`,
    )
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields

  // Scheduler refuses a schedule that constrains both day fields; `?` is how the unused one is
  // spelled. Standard cron treats "both specified" as a union, which is a different schedule — so
  // an expression that constrains both is refused rather than silently reinterpreted.
  if (dayOfMonth !== '*' && dayOfWeek !== '*') {
    throw new Error(
      `Cannot register a schedule from ${expression}: it constrains both day-of-month and day-of-week, which Scheduler cannot express.`,
    )
  }

  const schedulerDayOfWeek = dayOfWeek === '*' ? '?' : dayOfWeek
  const schedulerDayOfMonth = dayOfMonth === '*' && dayOfWeek !== '*' ? '?' : dayOfMonth

  return `cron(${minute} ${hour} ${schedulerDayOfMonth} ${month} ${schedulerDayOfWeek} *)`
}

/** The schedule an integration row should have. */
export const scheduleDefinitionFor = (integration: Integration): ScheduleDefinition => ({
  name: scheduleNameFor(integration.id),
  expression: toSchedulerExpression(integration.cronExpression),
  timezone: integration.timezone,
  payload: schedulePayloadFor(integration.id),
  enabled: integration.enabled,
})

/** What one integration's reconciliation did. */
export interface ScheduleAction {
  readonly integrationId: string
  readonly scheduleName: string
  readonly action: 'registered' | 'disabled' | 'removed' | 'failed'
  /** Why, when the action is `failed`. Recorded rather than thrown: one bad row is not a sweep. */
  readonly error?: string
}

export interface SyncSchedulesResult {
  readonly actions: readonly ScheduleAction[]
  /** Schedules removed because their integration no longer exists. */
  readonly swept: readonly string[]
  readonly failures: number
}

export interface SyncSchedulesOptions {
  readonly db: SisyphusDatabase
  readonly schedules: ScheduleRegistry
}

/**
 * Bring the schedule group to what the `integrations` table says it should be.
 *
 * @param options - The database handle and the registry seam (`src/aws/schedules.ts`).
 * @returns One action per integration, plus whatever the sweep removed.
 */
export const syncSchedules = async (
  options: SyncSchedulesOptions,
): Promise<SyncSchedulesResult> => {
  const { db, schedules } = options
  const rows = await listIntegrations(db)
  const actions: ScheduleAction[] = []
  const known = new Set<string>()

  for (const integration of rows) {
    const scheduleName = scheduleNameFor(integration.id)
    known.add(scheduleName)

    try {
      // Upsert in both directions. A disabled integration keeps its schedule in the `DISABLED`
      // state rather than losing it, and — crucially — an integration disabled since the last sweep
      // has its schedule *brought* to disabled rather than left firing.
      await schedules.upsert(scheduleDefinitionFor(integration))

      if (integration.scheduleArn === null) {
        // The row records that a schedule exists. The registry owns the ARN; what matters here is
        // that a row and a schedule are never in different states, so the marker is written after
        // the upsert rather than before it.
        await db
          .update(integrations)
          .set({ scheduleArn: scheduleName })
          .where(eq(integrations.id, integration.id))
      }

      actions.push({
        integrationId: integration.id,
        scheduleName,
        action: integration.enabled ? 'registered' : 'disabled',
      })
    } catch (thrown) {
      actions.push({
        integrationId: integration.id,
        scheduleName,
        action: 'failed',
        error: toError(thrown).message,
      })
    }
  }

  const swept: string[] = []

  for (const name of await schedules.list()) {
    const integrationId = integrationIdFromScheduleName(name)

    // Never touch a schedule this platform did not create: the group may be shared, and a sweep
    // that deleted an unrecognised name would be a sweep that deleted somebody else's timer.
    if (integrationId === undefined || known.has(name)) {
      continue
    }

    await schedules.remove({ name })
    swept.push(name)
  }

  return { actions, swept, failures: actions.filter((action) => action.action === 'failed').length }
}

/**
 * Remove one integration's schedule — for `admin.integrations.delete`, where the row goes away.
 *
 * Idempotent, because `ScheduleRegistry.remove` is: removing an absent schedule succeeds.
 */
export const removeSchedule = async (
  schedules: ScheduleRegistry,
  integrationId: string,
): Promise<void> => {
  await schedules.remove({ name: scheduleNameFor(integrationId) })
}

/** The sweep wrapped in the uniform job envelope. */
export const runSyncSchedules = (
  options: SyncSchedulesOptions,
): Promise<JobOutcome<SyncSchedulesResult>> =>
  runJob(SYNC_SCHEDULES_JOB_NAME, () => syncSchedules(options))
