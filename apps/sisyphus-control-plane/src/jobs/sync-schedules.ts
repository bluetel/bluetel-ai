import type { Integration, SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'
import { integrations } from '@bluetel-ai/sisyphus-api/db'
import { eq } from 'drizzle-orm'

import type { ScheduleDefinition, ScheduleRegistry } from '../aws'
import { KEEP_ALIVE_JOB_NAME } from '../credentials/liveness'

import { CREDENTIAL_ALERTS_JOB_NAME } from './credential-alerts'
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
 *
 * ## Platform schedules, which belong to no row (003/FR-035)
 *
 * Everything above is about schedules derived from `integrations`. {@link PLATFORM_SCHEDULES} is the
 * other kind: timers the platform needs whether or not anybody has configured anything, registered
 * by this same reconciler because it is the only thing that ever talks to the schedule group.
 *
 * There are two, and both are about the credential pool. The keep-alive sweep is here rather than in
 * the stage's own tick for a reason worth stating: FR-035 requires credentials to be exercised **on
 * a schedule, independently of workflow demand**, and a job that only ran as part of something else
 * would be a job that stopped running whenever that something else was disabled or throttled.
 * SC-009's failure mode — a pool that has quietly expired — is invisible until a workflow tries to
 * use it, so the timer that prevents it must not be conditional on anything.
 *
 * The FR-056 alert sweep is the second, and it is a **separate** entry rather than a step inside
 * keep-alive for the sharpest version of the same argument: one of the four alerts it raises is
 * "this seat has not been exercised for most of its idle window", which is precisely what a
 * deployment sees when keep-alive has stopped running. An alert that fired only as part of the job
 * it is watching would go quiet in the one case it was written for.
 *
 * Their names carry {@link PLATFORM_SCHEDULE_PREFIX}, which is deliberately **not**
 * {@link SCHEDULE_NAME_PREFIX}. That is what keeps the integration sweep from deleting them:
 * `integrationIdFromScheduleName` does not recognise the platform prefix, so a platform schedule is
 * one of the "not ours" names the sweep already declines to touch, and it stays that way without a
 * special case anybody has to remember.
 */

export const SYNC_SCHEDULES_JOB_NAME = 'sync-schedules'

/** Prefix on every schedule this platform owns, so a sweep cannot delete somebody else's. */
export const SCHEDULE_NAME_PREFIX = 'sisyphus-integration-'

/** Prefix on schedules that belong to the platform rather than to any row. See the module note. */
export const PLATFORM_SCHEDULE_PREFIX = 'sisyphus-platform-'

/** The keep-alive sweep's schedule (FR-035, SC-009). */
export const KEEP_ALIVE_SCHEDULE_NAME = `${PLATFORM_SCHEDULE_PREFIX}${KEEP_ALIVE_JOB_NAME}`

/**
 * How often the keep-alive sweep runs — which is **not** the same number as
 * `SISYPHUS_KEEPALIVE_IDLE_HOURS`.
 *
 * The idle threshold says how stale a credential may get; this says how often the platform looks.
 * The cadence has to be the finer of the two, or a credential could sit a whole extra interval past
 * its threshold before anything noticed. Hourly against a 24-hour default gives twenty-four looks
 * inside one threshold, and each look is bounded by `DEFAULT_KEEP_ALIVE_BATCH` — so a pass costs a
 * handful of provider round trips at most, and a pass with nothing to do costs one query.
 */
export const KEEP_ALIVE_SCHEDULE_EXPRESSION = 'rate(1 hour)'

/** The FR-056 alert sweep's schedule. */
export const CREDENTIAL_ALERTS_SCHEDULE_NAME = `${PLATFORM_SCHEDULE_PREFIX}${CREDENTIAL_ALERTS_JOB_NAME}`

/**
 * How often the pool is looked at for conditions worth a person — the same hourly cadence as
 * keep-alive, and for a related but not identical reason.
 *
 * The finer-of-the-two argument above applies here as well: the expiry alert fires in the last
 * quarter of `SISYPHUS_KEEPALIVE_IDLE_HOURS`, which is six hours against the 24-hour default and
 * ninety minutes for a deployment that measures the real window at six. A cadence coarser than an
 * hour could therefore step over the warning window entirely and deliver nothing before the login
 * lapsed, which is the alert doing the opposite of its job.
 *
 * The cost of the other direction is repetition, and it is accepted deliberately. Nothing in the
 * alert path coalesces — `credential-alerts.ts` in the notify package explains why these are not
 * `notifications` rows and therefore have no dedupe window — so a broken seat is raised once an
 * hour until somebody fixes it. That is the right pressure for a condition that is only ever
 * cleared by a person: the four conditions are each minutes of work, and a pool with none of them
 * produces no message at all.
 */
export const CREDENTIAL_ALERTS_SCHEDULE_EXPRESSION = 'rate(1 hour)'

/**
 * Schedules the platform keeps regardless of configuration.
 *
 * `UTC`, because a rate expression has no wall clock to keep — the timezone field is required and
 * naming the platform's own zone here would imply a daylight-saving behaviour the expression does
 * not have. That is the opposite of the integration case (FR-155), where the wall clock is the
 * whole point.
 */
export const PLATFORM_SCHEDULES: readonly ScheduleDefinition[] = [
  {
    name: KEEP_ALIVE_SCHEDULE_NAME,
    expression: KEEP_ALIVE_SCHEDULE_EXPRESSION,
    timezone: 'UTC',
    payload: JSON.stringify({ job: KEEP_ALIVE_JOB_NAME }),
    enabled: true,
  },
  {
    name: CREDENTIAL_ALERTS_SCHEDULE_NAME,
    expression: CREDENTIAL_ALERTS_SCHEDULE_EXPRESSION,
    timezone: 'UTC',
    payload: JSON.stringify({ job: CREDENTIAL_ALERTS_JOB_NAME }),
    enabled: true,
  },
]

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
  /** Platform schedules brought to their definition this pass. See {@link PLATFORM_SCHEDULES}. */
  readonly platform: readonly string[]
  /**
   * Why a platform schedule could not be registered, one per failure.
   *
   * Recorded rather than thrown, the same rule the integration rows follow: one schedule the
   * registry refused is not a reason to abandon the rest of the sweep, and the next pass will try
   * again. They count towards {@link SyncSchedulesResult.failures} because a keep-alive timer that
   * is not there is not a lesser problem than an integration's — it is the one that ends in an
   * expired pool.
   */
  readonly platformErrors: readonly string[]
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
  const platform: string[] = []
  const platformErrors: string[] = []

  // First, and unconditionally: these belong to no row, so nothing about the `integrations` table
  // can make them unnecessary. A deployment with no integrations at all still needs its pool kept
  // alive (FR-035).
  for (const definition of PLATFORM_SCHEDULES) {
    try {
      await schedules.upsert(definition)
      platform.push(definition.name)
    } catch (thrown) {
      platformErrors.push(`${definition.name}: ${toError(thrown).message}`)
    }
  }

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

  return {
    actions,
    swept,
    platform,
    platformErrors,
    failures: actions.filter((action) => action.action === 'failed').length + platformErrors.length,
  }
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
