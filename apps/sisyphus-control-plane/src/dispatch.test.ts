import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ControlPlaneContext } from './context'
import type { JobOutcome } from './jobs'

/**
 * The jobs are mocked, and that is the point of this file.
 *
 * Every one of the eight is covered by its own suite against fakes; what has never been asserted
 * anywhere is that an *event* reaches the right one carrying the right subject and the right ports.
 * A test that ran the real jobs would need a database to say anything about routing, and would say
 * it about admission rather than about the router.
 */

const succeeded = (jobName: string): JobOutcome<unknown> => ({
  ok: true,
  jobName,
  durationMs: 1,
  value: undefined,
})

const failed = (jobName: string, message: string): JobOutcome<unknown> => ({
  ok: false,
  jobName,
  durationMs: 2,
  error: new Error(message),
})

const runAdmitWorkflow = vi.fn(() => Promise.resolve(succeeded('admit-workflow')))
const runBootstrapAdmins = vi.fn(() => Promise.resolve(succeeded('bootstrap-admins')))
const runCredentialAlerts = vi.fn(() => Promise.resolve(succeeded('credential-alerts')))
const runDrainQueue = vi.fn(() => Promise.resolve(succeeded('drain-queue')))
const runIntegrationTick = vi.fn(() => Promise.resolve(succeeded('integration-tick')))
const runReconcile = vi.fn(() => Promise.resolve(succeeded('reconcile')))
const runStartWorkflow = vi.fn(() => Promise.resolve(succeeded('start-workflow')))
const runSyncSchedules = vi.fn(() => Promise.resolve(succeeded('sync-schedules')))
const runTeardownWorkflow = vi.fn(() => Promise.resolve(succeeded('teardown-workflow')))
const sweepKeepAlive = vi.fn(() => Promise.resolve({ considered: 0 }))

const everyJob = {
  runAdmitWorkflow,
  runBootstrapAdmins,
  runCredentialAlerts,
  runDrainQueue,
  runIntegrationTick,
  runReconcile,
  runStartWorkflow,
  runSyncSchedules,
  runTeardownWorkflow,
  sweepKeepAlive,
  // The keep-alive sweep has no `runKeepAlive` of its own — it lives in `credentials/liveness/`,
  // which cannot import this directory's job envelope without a cycle — so the router wraps it.
  // Both pieces have to be in the mock for that route to reach anything.
  KEEP_ALIVE_JOB_NAME: 'keep-alive',
  runJob: async (jobName: string, handler: () => Promise<unknown>) => ({
    ok: true,
    jobName,
    durationMs: 1,
    value: await handler(),
  }),
}

vi.mock('./jobs', () => everyJob)

const {
  CONTROL_PLANE_JOB_NAMES,
  CONTROL_PLANE_TICK,
  CONTROL_PLANE_TICK_SEQUENCE,
  parseControlPlaneEvent,
  runControlPlaneEvent,
  summariseInvocation,
} = await import('./dispatch')

/**
 * Sentinel ports. Each is a string so a failed assertion says which port arrived where, rather than
 * printing two structurally identical fakes and leaving the reader to spot the difference.
 */
const context = {
  db: 'the-database',
  compute: 'the-compute',
  objectStore: 'the-object-store',
  schedules: 'the-schedules',
  connectors: 'the-connectors',
  redactor: 'the-redactor',
  readCredential: 'the-credential-reader',
  buckets: { logs: 'logs-bucket', artifacts: 'artifacts-bucket', snapshots: 'snapshots-bucket' },
  ceiling: 7,
  credentialWaitLimitMs: 900_000,
  keepAliveIdleHours: 24,
  coolingOffRetryMs: 900_000,
  credentialExerciser: 'the-credential-exerciser',
  machineSurfaceUrl: 'https://machine.example',
  credentialSecret: 'the-credential-secret',
  bootstrapAdminEmails: ['admin@example.com'],
  starter: 'the-starter',
  queueDrain: 'the-queue-drain',
  notifier: 'the-notifier',
  credentialAlerter: 'the-credential-alerter',
} as unknown as ControlPlaneContext

beforeEach(() => {
  for (const job of Object.values(everyJob)) {
    // Not everything in the mocked module is a spy: the router also needs the job envelope and a
    // job name from `./jobs`, and neither has calls to clear.
    if (vi.isMockFunction(job)) {
      job.mockClear()
    }
  }
})

describe('parseControlPlaneEvent', () => {
  it('accepts the payload the per-integration schedules are registered with', () => {
    // Byte for byte what `schedulePayloadFor` writes into every schedule (FR-100).
    const payload: unknown = JSON.parse(
      '{"job":"integration-tick","integrationId":"int_42","trigger":"scheduled"}',
    )

    expect(parseControlPlaneEvent(payload)).toStrictEqual({
      job: 'integration-tick',
      integrationId: 'int_42',
      trigger: 'scheduled',
    })
  })

  it("accepts the stage tick's payload, as sisyphus-infra writes it", () => {
    expect(parseControlPlaneEvent(JSON.parse('{"job":"control-plane-tick"}'))).toStrictEqual({
      job: CONTROL_PLANE_TICK,
    })
  })

  it('accepts every job name it routes', () => {
    const subjects: Record<string, unknown> = {
      'admit-workflow': { workflowId: 'wf_1' },
      'integration-tick': { integrationId: 'int_1' },
      'start-workflow': { workflowId: 'wf_1' },
      'teardown-workflow': { workflowId: 'wf_1' },
    }

    for (const job of CONTROL_PLANE_JOB_NAMES) {
      expect(parseControlPlaneEvent({ job, ...(subjects[job] ?? {}) })).toMatchObject({ job })
    }
  })

  it.each([
    ['an event naming no job at all', {}],
    ['an event naming a job nothing routes', { job: 'take-over-the-world' }],
    ['a JSON string rather than a payload', '{"job":"reconcile"}'],
    ['null, which is what an empty schedule input decodes to', null],
    ['admission with no workflow', { job: 'admit-workflow' }],
    ['admission with a blank workflow id', { job: 'admit-workflow', workflowId: '' }],
    ['a tick naming no integration', { job: 'integration-tick' }],
    ['a trigger nothing recognises', { job: 'integration-tick', integrationId: 'i', trigger: 'x' }],
    ['a drain with a nonsensical limit', { job: 'drain-queue', limit: 0 }],
  ])('refuses %s', (_description, event) => {
    expect(() => parseControlPlaneEvent(event)).toThrow('cannot route')
  })

  it('names every job it would have accepted, so the refusal is actionable', () => {
    expect(() => parseControlPlaneEvent({ job: 'unknown' })).toThrow(
      'admit-workflow, bootstrap-admins, credential-alerts, drain-queue, integration-tick, keep-alive, reconcile, start-workflow, sync-schedules, teardown-workflow, control-plane-tick',
    )
  })
})

describe('runControlPlaneEvent', () => {
  it('routes admission with the workflow and the ceiling in force', async () => {
    await runControlPlaneEvent(context, { job: 'admit-workflow', workflowId: 'wf_1' })

    expect(runAdmitWorkflow).toHaveBeenCalledWith({
      db: 'the-database',
      workflowId: 'wf_1',
      ceiling: 7,
    })
  })

  it('routes the bootstrap reconcile with the configured addresses', async () => {
    await runControlPlaneEvent(context, { job: 'bootstrap-admins' })

    expect(runBootstrapAdmins).toHaveBeenCalledWith({
      db: 'the-database',
      emails: ['admin@example.com'],
    })
  })

  it('routes the drain with the provisioning starter, and passes a limit through', async () => {
    await runControlPlaneEvent(context, { job: 'drain-queue', limit: 3 })

    expect(runDrainQueue).toHaveBeenCalledWith({
      db: 'the-database',
      ceiling: 7,
      starter: 'the-starter',
      limit: 3,
      // The drain is where a wait is expired and announced (003/FR-028, FR-136), so it takes the
      // configured limit and the notifier rather than reading either itself.
      credentialWaitLimitMs: 900_000,
      notifier: 'the-notifier',
    })
  })

  it('routes the integration tick with the connector registry and the credential reader', async () => {
    await runControlPlaneEvent(context, {
      job: 'integration-tick',
      integrationId: 'int_42',
      trigger: 'manual',
    })

    expect(runIntegrationTick).toHaveBeenCalledWith({
      db: 'the-database',
      connectors: 'the-connectors',
      readCredential: 'the-credential-reader',
      redactor: 'the-redactor',
      notifier: 'the-notifier',
      integrationId: 'int_42',
      trigger: 'manual',
    })
  })

  it("leaves an untagged tick's trigger to the job's own default", async () => {
    await runControlPlaneEvent(context, { job: 'integration-tick', integrationId: 'int_42' })

    expect(runIntegrationTick).toHaveBeenCalledWith(expect.objectContaining({ trigger: undefined }))
  })

  it('routes the reconcile with compute, the drain, and the cooling-off retry interval', async () => {
    await runControlPlaneEvent(context, { job: 'reconcile' })

    expect(runReconcile).toHaveBeenCalledWith({
      db: 'the-database',
      compute: 'the-compute',
      queueDrain: 'the-queue-drain',
      notifier: 'the-notifier',
      // 003/FR-078. Converted once, in the composition root, so the job never reads configuration.
      coolingOffRetryMs: 900_000,
    })
  })

  it('routes the keep-alive sweep with the provider seam and the idle threshold (003/FR-035)', async () => {
    await runControlPlaneEvent(context, { job: 'keep-alive' })

    expect(sweepKeepAlive).toHaveBeenCalledWith({
      db: 'the-database',
      exerciser: 'the-credential-exerciser',
      idleHours: 24,
    })
  })

  it('keeps keep-alive out of the stage tick, so it runs independently of demand (003/FR-035)', () => {
    // FR-035 requires the pool to be exercised independently of workflow demand. A sweep that only
    // ran inside the stage tick would stop running whenever the tick did, and SC-009's failure —
    // a pool that has quietly expired — is invisible until a workflow tries to use it.
    expect(CONTROL_PLANE_TICK_SEQUENCE.map((step) => step.job)).not.toContain('keep-alive')
  })

  it('routes the FR-056 alert sweep with the alerter and no threshold of its own', async () => {
    await runControlPlaneEvent(context, { job: 'credential-alerts' })

    // The two hour knobs are bound into the alerter in the composition root, so the job is handed
    // neither — there is nowhere for a second opinion about them to live.
    expect(runCredentialAlerts).toHaveBeenCalledWith({
      db: 'the-database',
      alerter: 'the-credential-alerter',
    })
  })

  it('keeps the alert sweep out of both the stage tick and keep-alive (003/FR-056)', () => {
    // One of the four conditions it raises is a seat keep-alive has stopped exercising, so an alert
    // that only ran inside keep-alive would go silent in the case it was written for. The stage
    // tick is wrong for a different reason: it runs once a minute and nothing in the alert path
    // coalesces.
    expect(CONTROL_PLANE_TICK_SEQUENCE.map((step) => step.job)).not.toContain('credential-alerts')
  })

  it('routes provisioning with the machine surface and the credential secret', async () => {
    await runControlPlaneEvent(context, { job: 'start-workflow', workflowId: 'wf_2' })

    expect(runStartWorkflow).toHaveBeenCalledWith({
      db: 'the-database',
      compute: 'the-compute',
      machineSurfaceUrl: 'https://machine.example',
      credentialSecret: 'the-credential-secret',
      workflowId: 'wf_2',
    })
  })

  it('routes the schedule sweep with the registry', async () => {
    await runControlPlaneEvent(context, { job: 'sync-schedules' })

    expect(runSyncSchedules).toHaveBeenCalledWith({
      db: 'the-database',
      schedules: 'the-schedules',
    })
  })

  it('routes teardown with the object store and the three durability buckets', async () => {
    await runControlPlaneEvent(context, { job: 'teardown-workflow', workflowId: 'wf_3' })

    expect(runTeardownWorkflow).toHaveBeenCalledWith({
      db: 'the-database',
      compute: 'the-compute',
      objectStore: 'the-object-store',
      buckets: {
        logs: 'logs-bucket',
        artifacts: 'artifacts-bucket',
        snapshots: 'snapshots-bucket',
      },
      workflowId: 'wf_3',
      queueDrain: 'the-queue-drain',
    })
  })

  it('runs exactly one job for an event naming one job', async () => {
    const outcomes = await runControlPlaneEvent(context, { job: 'reconcile' })

    expect(outcomes).toHaveLength(1)
    expect(runDrainQueue).not.toHaveBeenCalled()
    expect(runSyncSchedules).not.toHaveBeenCalled()
  })
})

describe('the stage tick', () => {
  it('drains, reconciles and syncs schedules, in that order', async () => {
    const outcomes = await runControlPlaneEvent(context, { job: CONTROL_PLANE_TICK })

    expect(CONTROL_PLANE_TICK_SEQUENCE.map((step) => step.job)).toStrictEqual([
      'drain-queue',
      'reconcile',
      'sync-schedules',
    ])
    expect(outcomes.map((outcome) => outcome.jobName)).toStrictEqual([
      'drain-queue',
      'reconcile',
      'sync-schedules',
    ])
  })

  it('does not reinstate bootstrap admins on a timer — that is a deploy-time reconcile', async () => {
    await runControlPlaneEvent(context, { job: CONTROL_PLANE_TICK })

    expect(runBootstrapAdmins).not.toHaveBeenCalled()
  })

  it('runs every step even when an earlier one failed', async () => {
    runDrainQueue.mockResolvedValueOnce(failed('drain-queue', 'the pool is gone'))

    const outcomes = await runControlPlaneEvent(context, { job: CONTROL_PLANE_TICK })

    expect(runReconcile).toHaveBeenCalledOnce()
    expect(runSyncSchedules).toHaveBeenCalledOnce()
    expect(outcomes.map((outcome) => outcome.ok)).toStrictEqual([false, true, true])
  })
})

describe('summariseInvocation', () => {
  it('reports one entry per job, with durations and no outcome values', () => {
    const summary = summariseInvocation({ job: 'reconcile' }, [succeeded('reconcile')])

    expect(summary).toStrictEqual({
      job: 'reconcile',
      ok: true,
      jobs: [{ jobName: 'reconcile', ok: true, durationMs: 1 }],
    })
  })

  it('is not ok when any job failed, and carries the message rather than the error', () => {
    const summary = summariseInvocation({ job: CONTROL_PLANE_TICK }, [
      succeeded('drain-queue'),
      failed('reconcile', 'EC2 refused'),
    ])

    expect(summary.ok).toBe(false)
    expect(summary.jobs[1]).toStrictEqual({
      jobName: 'reconcile',
      ok: false,
      durationMs: 2,
      error: 'EC2 refused',
    })
  })
})
