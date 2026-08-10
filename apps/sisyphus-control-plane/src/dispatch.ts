import { z } from 'zod'

import type { ControlPlaneContext } from './context'
import type { JobOutcome } from './jobs'
import {
  KEEP_ALIVE_JOB_NAME,
  runAdmitWorkflow,
  runBootstrapAdmins,
  runCredentialAlerts,
  runDrainQueue,
  runIntegrationTick,
  runJob,
  runPauseInstance,
  runReconcile,
  runResumeWorkflow,
  runStartWorkflow,
  runSyncSchedules,
  runTeardownWorkflow,
  sweepKeepAlive,
} from './jobs'

/**
 * What an invocation of the control plane means (T172).
 *
 * The control plane has no inbound network surface (FR-035): every invocation is EventBridge
 * Scheduler firing a schedule, or something inside the platform invoking the function directly.
 * Neither carries a route, a method or a path — only a JSON payload — so this module is where a
 * payload becomes a job, and it is deliberately the *whole* of that decision.
 *
 * ## An envelope, not a sniffed shape
 *
 * Every payload names its job. That is not a convention this module invented: `sync-schedules.ts`
 * already writes `{"job":"integration-tick","integrationId":…,"trigger":"scheduled"}` into every
 * per-integration schedule it registers, and `sisyphus-infra`'s `buildControlPlaneTickSpecification`
 * writes `{"job":"control-plane-tick"}` into the stage's tick. Both are the contract this parser
 * implements; changing either without the other is a schedule whose target refuses it, loudly and
 * on the first fire, which is the failure mode to want.
 *
 * ## Unknown events fail
 *
 * A payload naming no job, or naming one nothing here routes, throws. It does not return a
 * no-op success. A schedule that fires into silence looks identical to a platform with nothing to
 * do, and the whole point of a tick is that somebody notices when it stops working.
 *
 * ## What the stage tick does, and what it deliberately does not
 *
 * The tick fires once a minute and drives {@link CONTROL_PLANE_TICK_SEQUENCE} in order: drain the
 * queue so admitted work is provisioned, reconcile so leases and instances that outlived their runs
 * are released, then sync schedules so the group matches the `integrations` table (FR-100) — the
 * control plane cannot be told an integration changed, so converging on a cadence is how it finds
 * out. Every step runs even if an earlier one failed, because they are independent reconciles and
 * a reconciler that stopped at the first failure would stop at the same failure every minute.
 *
 * `bootstrap-admins` is **not** in the sequence, though it is reachable as its own event. It is a
 * deploy-time reconcile (FR-174): running it every minute would silently reinstate a bootstrap
 * admin somebody had deliberately deactivated, within the minute, and revocation is meant to be an
 * explicit attributed action rather than a race against a timer.
 */

/** Every job an event may name. Sorted, because this list is also an error message. */
export const CONTROL_PLANE_JOB_NAMES = [
  'admit-workflow',
  'bootstrap-admins',
  'credential-alerts',
  'drain-queue',
  'integration-tick',
  'keep-alive',
  'pause-instance',
  'reconcile',
  'resume-workflow',
  'start-workflow',
  'sync-schedules',
  'teardown-workflow',
] as const

export type ControlPlaneJobName = (typeof CONTROL_PLANE_JOB_NAMES)[number]

/** The stage's own schedule, which is a fan-out rather than a job. */
export const CONTROL_PLANE_TICK = 'control-plane-tick'

const workflowIdField = z.string().min(1)

/**
 * The event envelope.
 *
 * A discriminated union rather than one permissive object: `admit-workflow` without a workflow id
 * and `integration-tick` without an integration id are not events with a missing field, they are
 * events that cannot be acted on, and the difference should be visible where the payload is written
 * rather than three calls into a job.
 */
const controlPlaneEventSchema = z.discriminatedUnion('job', [
  z.object({ job: z.literal('admit-workflow'), workflowId: workflowIdField }),
  z.object({ job: z.literal('bootstrap-admins') }),
  /**
   * The FR-056 administrator alert sweep. Its own event and **not** part of the stage tick, and
   * deliberately not part of `keep-alive` either — one of the four conditions it raises is a seat
   * that keep-alive has stopped exercising, so an alert that only ran inside keep-alive would be
   * silent in the case it exists for. `sync-schedules.ts` registers its timer.
   */
  z.object({ job: z.literal('credential-alerts') }),
  z.object({ job: z.literal('drain-queue'), limit: z.number().int().positive().optional() }),
  z.object({
    job: z.literal('integration-tick'),
    integrationId: z.string().min(1),
    /** `manual` is an admin pressing Run now (FR-097); the schedule writes `scheduled`. */
    trigger: z.enum(['scheduled', 'manual']).optional(),
  }),
  /**
   * The keep-alive sweep (003/FR-035). Its own event and **not** part of the stage tick, because
   * FR-035 requires it to run independently of workflow demand — a sweep that only happened inside
   * something else would stop happening whenever that something else did. `sync-schedules.ts`
   * registers the timer that fires this.
   */
  z.object({ job: z.literal('keep-alive') }),
  /**
   * The stop half of a pause (003/FR-039). Its own per-workflow event, on exactly the footing
   * `start-workflow` and `teardown-workflow` are on: a pause is a thing that happens to **one**
   * run at a known moment — the instant its executor acknowledges the pause command and
   * `workflows.state` becomes `paused` — and not a population to be swept.
   *
   * It is deliberately **not** in {@link CONTROL_PLANE_TICK_SEQUENCE}. See `jobs/reconcile.ts`,
   * which is the backstop for a pause whose stop never came: a stop issued twice a minute against
   * a run that is already stopping is an EC2 call per tick for as long as somebody is at lunch,
   * and the reconciler already carries the clock that decides when an unattended pause has gone
   * on too long.
   */
  z.object({ job: z.literal('pause-instance'), workflowId: workflowIdField }),
  z.object({ job: z.literal('reconcile') }),
  /**
   * The other half of the same decision (003/FR-041, FR-043, FR-046).
   *
   * A resume cannot travel the supervision queue the way a pause does, and that asymmetry is the
   * whole reason this event exists. A pause is applied by an executor that is still running; a
   * resume is asked of a run whose instance is **stopped**, so there is nothing polling
   * `pullPendingCommands` and a queued `resume` row would sit unread for ever. Somebody outside
   * the instance has to start it, and this is that somebody.
   */
  z.object({ job: z.literal('resume-workflow'), workflowId: workflowIdField }),
  z.object({ job: z.literal('start-workflow'), workflowId: workflowIdField }),
  z.object({ job: z.literal('sync-schedules') }),
  z.object({ job: z.literal('teardown-workflow'), workflowId: workflowIdField }),
  z.object({ job: z.literal(CONTROL_PLANE_TICK) }),
])

export type ControlPlaneEvent = z.infer<typeof controlPlaneEventSchema>

/** One event naming one job — every event except the stage tick's fan-out. */
export type ControlPlaneJobEvent = Exclude<ControlPlaneEvent, { job: typeof CONTROL_PLANE_TICK }>

/** What the stage tick runs, in order. */
export const CONTROL_PLANE_TICK_SEQUENCE: readonly ControlPlaneJobEvent[] = [
  { job: 'drain-queue' },
  { job: 'reconcile' },
  { job: 'sync-schedules' },
]

const knownJobs = [...CONTROL_PLANE_JOB_NAMES, CONTROL_PLANE_TICK].join(', ')

/**
 * The event, or a refusal naming what would have been accepted.
 *
 * @param event - The raw Lambda payload.
 * @throws If the payload names no known job, or names one whose subject is missing.
 */
export const parseControlPlaneEvent = (event: unknown): ControlPlaneEvent => {
  const parsed = controlPlaneEventSchema.safeParse(event)

  if (!parsed.success) {
    throw new Error(
      `The control plane was invoked with an event it cannot route: ${JSON.stringify(event)}. ` +
        `Every payload must name its job — one of ${knownJobs} — and carry that job's subject. ` +
        `Refused because: ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`,
    )
  }

  return parsed.data
}

/**
 * Route one event to its job.
 *
 * A `switch` rather than a lookup table: each job takes a different subject off the event and a
 * different set of ports off the context, and a table of uniformly-typed entries would have to
 * widen both and cast them back. Exhaustiveness is checked by the compiler either way.
 *
 * @param context - The assembled ports. See `context.ts`.
 * @param event - A parsed event naming exactly one job.
 */
const runControlPlaneJob = (
  context: ControlPlaneContext,
  event: ControlPlaneJobEvent,
): Promise<JobOutcome<unknown>> => {
  switch (event.job) {
    case 'admit-workflow':
      return runAdmitWorkflow({
        db: context.db,
        workflowId: event.workflowId,
        ceiling: context.ceiling,
      })

    case 'bootstrap-admins':
      return runBootstrapAdmins({ db: context.db, emails: context.bootstrapAdminEmails })

    case 'credential-alerts':
      // The alerter carries both thresholds, bound in the composition root — see `context.ts`. The
      // job is handed no hour value of its own, so there is nowhere for a second opinion about
      // `SISYPHUS_KEEPALIVE_IDLE_HOURS` to live.
      return runCredentialAlerts({ db: context.db, alerter: context.credentialAlerter })

    case 'drain-queue':
      return runDrainQueue({
        db: context.db,
        ceiling: context.ceiling,
        starter: context.starter,
        limit: event.limit,
        // The FR-028 limit and the notifier travel together: the drain is the job that fails a run
        // for waiting too long, and a run failed by the platform that never tells its owner is a
        // failure nobody hears about (FR-136).
        credentialWaitLimitMs: context.credentialWaitLimitMs,
        notifier: context.notifier,
      })

    case 'integration-tick':
      return runIntegrationTick({
        db: context.db,
        connectors: context.connectors,
        readCredential: context.readCredential,
        redactor: context.redactor,
        notifier: context.notifier,
        integrationId: event.integrationId,
        // Passed through rather than defaulted here: the tick's own default is `scheduled`, and
        // restating it would give the platform two places to disagree about what an untagged
        // invocation was.
        trigger: event.trigger,
      })

    case 'keep-alive':
      return runJob(KEEP_ALIVE_JOB_NAME, () =>
        sweepKeepAlive({
          db: context.db,
          exerciser: context.credentialExerciser,
          idleHours: context.keepAliveIdleHours,
        }),
      )

    case 'pause-instance':
      // The drain travels with it because two of the three pause paths release a compute lease —
      // the spot degrade and the park — and a freed slot that nothing re-admits is a queue that
      // waits a tick for capacity it already has. The stop path releases nothing and drains
      // nothing; that decision is the job's, not this router's. See `jobs/pause-instance.ts`.
      return runPauseInstance({
        db: context.db,
        compute: context.compute,
        workflowId: event.workflowId,
        queueDrain: context.queueDrain,
      })

    case 'reconcile':
      return runReconcile({
        db: context.db,
        compute: context.compute,
        queueDrain: context.queueDrain,
        notifier: context.notifier,
        coolingOffRetryMs: context.coolingOffRetryMs,
      })

    case 'resume-workflow':
      // The same dependencies provisioning takes, and that is the point rather than a coincidence:
      // a resume that cannot start the stopped instance rebuilds the run from its snapshot onto a
      // fresh one, which is `startWorkflow` with a different reason. A route that handed this job
      // less than the start route would be a resume that could only take the happy path.
      return runResumeWorkflow({
        db: context.db,
        compute: context.compute,
        machineSurfaceUrl: context.machineSurfaceUrl,
        credentialSecret: context.credentialSecret,
        workflowId: event.workflowId,
      })

    case 'start-workflow':
      return runStartWorkflow({
        db: context.db,
        compute: context.compute,
        machineSurfaceUrl: context.machineSurfaceUrl,
        credentialSecret: context.credentialSecret,
        workflowId: event.workflowId,
      })

    case 'sync-schedules':
      return runSyncSchedules({ db: context.db, schedules: context.schedules })

    case 'teardown-workflow':
      return runTeardownWorkflow({
        db: context.db,
        compute: context.compute,
        objectStore: context.objectStore,
        buckets: context.buckets,
        workflowId: event.workflowId,
        queueDrain: context.queueDrain,
      })
  }
}

/**
 * Run whatever the event asks for: one job, or the stage tick's sequence.
 *
 * Never throws for a job that failed — `runJob` captures that — so the caller gets one outcome per
 * job run and can report all of them rather than only the first.
 *
 * @param context - The assembled ports.
 * @param event - A parsed event.
 * @returns One outcome per job, in the order they ran.
 */
export const runControlPlaneEvent = async (
  context: ControlPlaneContext,
  event: ControlPlaneEvent,
): Promise<readonly JobOutcome<unknown>[]> => {
  if (event.job !== CONTROL_PLANE_TICK) {
    return [await runControlPlaneJob(context, event)]
  }

  const outcomes: JobOutcome<unknown>[] = []

  // Sequential and deliberately so: the drain provisions what it admits, and reconciling in
  // parallel with it would sweep leases whose instance is mid-launch.
  for (const step of CONTROL_PLANE_TICK_SEQUENCE) {
    outcomes.push(await runControlPlaneJob(context, step))
  }

  return outcomes
}

/** One job's result, flattened to something a log line and a Lambda response can both carry. */
export interface JobReport {
  readonly jobName: string
  readonly ok: boolean
  readonly durationMs: number
  /** The failure's message. Absent on success; never the value, which may be large. */
  readonly error?: string
}

export interface ControlPlaneInvocationSummary {
  /** The event's job, so a CloudWatch line says what fired without decoding the payload. */
  readonly job: ControlPlaneEvent['job']
  /** False if *any* job in the invocation failed. */
  readonly ok: boolean
  readonly jobs: readonly JobReport[]
}

/**
 * What the invocation did, as data.
 *
 * Outcome *values* are deliberately dropped: a drain reports every workflow it admitted and a
 * reconcile every instance it swept, and putting those in the Lambda response would put run
 * content into the invocation record of a platform whose whole storage story is retention-bounded
 * buckets. Durations and failures are what a scheduled invocation is alerted on.
 *
 * @param event - The event that was routed.
 * @param outcomes - One per job run, in order.
 */
export const summariseInvocation = (
  event: ControlPlaneEvent,
  outcomes: readonly JobOutcome<unknown>[],
): ControlPlaneInvocationSummary => ({
  job: event.job,
  ok: outcomes.every((outcome) => outcome.ok),
  jobs: outcomes.map((outcome) => ({
    jobName: outcome.jobName,
    ok: outcome.ok,
    durationMs: outcome.durationMs,
    ...(outcome.ok ? {} : { error: outcome.error.message }),
  })),
})
