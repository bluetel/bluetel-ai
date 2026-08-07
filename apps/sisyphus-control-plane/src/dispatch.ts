import { z } from 'zod'

import type { ControlPlaneContext } from './context'
import type { JobOutcome } from './jobs'
import {
  runAdmitWorkflow,
  runBootstrapAdmins,
  runDrainQueue,
  runIntegrationTick,
  runReconcile,
  runStartWorkflow,
  runSyncSchedules,
  runTeardownWorkflow,
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
  'drain-queue',
  'integration-tick',
  'reconcile',
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
  z.object({ job: z.literal('drain-queue'), limit: z.number().int().positive().optional() }),
  z.object({
    job: z.literal('integration-tick'),
    integrationId: z.string().min(1),
    /** `manual` is an admin pressing Run now (FR-097); the schedule writes `scheduled`. */
    trigger: z.enum(['scheduled', 'manual']).optional(),
  }),
  z.object({ job: z.literal('reconcile') }),
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

    case 'drain-queue':
      return runDrainQueue({
        db: context.db,
        ceiling: context.ceiling,
        starter: context.starter,
        limit: event.limit,
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

    case 'reconcile':
      return runReconcile({
        db: context.db,
        compute: context.compute,
        queueDrain: context.queueDrain,
        notifier: context.notifier,
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
