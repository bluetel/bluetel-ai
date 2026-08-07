import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ControlPlaneContext } from './context'
import type { JobOutcome } from './jobs'

/**
 * The handler `sst.config.ts` names, exercised end to end with the outside world mocked out.
 *
 * Three seams stand in for it: the validated environment (which would demand a real
 * `DATABASE_URL`), the composition root (which would open a pool and build four AWS clients) and
 * the jobs themselves (which would need Postgres to say anything). What is left is exactly what
 * this file is about — that an event arriving from EventBridge Scheduler or a direct invocation
 * reaches the right job, and that one that reaches none fails loudly.
 */

const outcome = (jobName: string, error?: string): JobOutcome<unknown> =>
  error === undefined
    ? { ok: true, jobName, durationMs: 3, value: undefined }
    : { ok: false, jobName, durationMs: 3, error: new Error(error) }

const runAdmitWorkflow = vi.fn(() => Promise.resolve(outcome('admit-workflow')))
const runBootstrapAdmins = vi.fn(() => Promise.resolve(outcome('bootstrap-admins')))
const runDrainQueue = vi.fn(() => Promise.resolve(outcome('drain-queue')))
const runIntegrationTick = vi.fn(() => Promise.resolve(outcome('integration-tick')))
const runReconcile = vi.fn(() => Promise.resolve(outcome('reconcile')))
const runStartWorkflow = vi.fn(() => Promise.resolve(outcome('start-workflow')))
const runSyncSchedules = vi.fn(() => Promise.resolve(outcome('sync-schedules')))
const runTeardownWorkflow = vi.fn(() => Promise.resolve(outcome('teardown-workflow')))

const everyJob = {
  runAdmitWorkflow,
  runBootstrapAdmins,
  runDrainQueue,
  runIntegrationTick,
  runReconcile,
  runStartWorkflow,
  runSyncSchedules,
  runTeardownWorkflow,
}

const context = { ceiling: 5 } as unknown as ControlPlaneContext
const createControlPlaneContext = vi.fn(() => context)
const env = { marker: 'the-validated-environment' }

vi.mock('./jobs', () => everyJob)
vi.mock('./context', () => ({ createControlPlaneContext }))
vi.mock('./env', () => ({ env }))

const { handler } = await import('./main')

beforeEach(() => {
  for (const job of Object.values(everyJob)) {
    job.mockClear()
  }
  createControlPlaneContext.mockClear()
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('handler', () => {
  it('is the symbol sst.config.ts declares as src/main.handler', () => {
    expect(handler).toBeTypeOf('function')
  })

  it.each([
    ['admit-workflow', { job: 'admit-workflow', workflowId: 'wf_1' }, runAdmitWorkflow],
    ['bootstrap-admins', { job: 'bootstrap-admins' }, runBootstrapAdmins],
    ['drain-queue', { job: 'drain-queue' }, runDrainQueue],
    ['integration-tick', { job: 'integration-tick', integrationId: 'int_1' }, runIntegrationTick],
    ['reconcile', { job: 'reconcile' }, runReconcile],
    ['start-workflow', { job: 'start-workflow', workflowId: 'wf_1' }, runStartWorkflow],
    ['sync-schedules', { job: 'sync-schedules' }, runSyncSchedules],
    ['teardown-workflow', { job: 'teardown-workflow', workflowId: 'wf_1' }, runTeardownWorkflow],
  ])('routes an event naming %s to that job and no other', async (jobName, event, job) => {
    const summary = await handler(event)

    expect(job).toHaveBeenCalledOnce()
    expect(summary).toStrictEqual({
      job: jobName,
      ok: true,
      jobs: [{ jobName, ok: true, durationMs: 3 }],
    })

    for (const [name, other] of Object.entries(everyJob)) {
      if (other !== job) {
        expect(other, `${name} should not have run`).not.toHaveBeenCalled()
      }
    }
  })

  it('fans the stage tick out over the drain, the reconcile and the schedule sweep', async () => {
    const summary = await handler({ job: 'control-plane-tick' })

    expect(runDrainQueue).toHaveBeenCalledOnce()
    expect(runReconcile).toHaveBeenCalledOnce()
    expect(runSyncSchedules).toHaveBeenCalledOnce()
    expect(summary.jobs.map((job) => job.jobName)).toStrictEqual([
      'drain-queue',
      'reconcile',
      'sync-schedules',
    ])
  })

  it('builds the context once per invocation, from the validated environment', async () => {
    await handler({ job: 'reconcile' })

    expect(createControlPlaneContext).toHaveBeenCalledExactlyOnceWith({ env })
  })

  it('refuses an event it cannot route rather than succeeding silently', async () => {
    await expect(handler({ job: 'delete-everything' })).rejects.toThrow('cannot route')

    for (const job of Object.values(everyJob)) {
      expect(job).not.toHaveBeenCalled()
    }
  })

  it.each([
    ['a payload naming no job', {}],
    ['an empty payload', null],
    ['admission with no workflow', { job: 'admit-workflow' }],
  ])('refuses %s', async (_description, event) => {
    await expect(handler(event)).rejects.toThrow('cannot route')
  })

  it('refuses before it reads the environment, so the message names the real fault', async () => {
    await expect(handler({ job: 'nonsense' })).rejects.toThrow('cannot route')

    expect(createControlPlaneContext).not.toHaveBeenCalled()
  })

  it('fails the invocation when a job failed, naming the job and its message', async () => {
    runReconcile.mockResolvedValueOnce(outcome('reconcile', 'EC2 refused the describe'))

    await expect(handler({ job: 'reconcile' })).rejects.toThrow(
      'reconcile: EC2 refused the describe',
    )
  })

  it('logs the summary of a failed tick before it throws, so the successes are not lost', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    runDrainQueue.mockResolvedValueOnce(outcome('drain-queue', 'the pool is gone'))

    await expect(handler({ job: 'control-plane-tick' })).rejects.toThrow('1 failed')

    expect(runSyncSchedules).toHaveBeenCalledOnce()
    expect(logged).toHaveBeenCalledWith(
      JSON.stringify({
        job: 'control-plane-tick',
        ok: false,
        jobs: [
          { jobName: 'drain-queue', ok: false, durationMs: 3, error: 'the pool is gone' },
          { jobName: 'reconcile', ok: true, durationMs: 3 },
          { jobName: 'sync-schedules', ok: true, durationMs: 3 },
        ],
      }),
    )
  })

  it('logs the summary of a successful invocation', async () => {
    const logged = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    await handler({ job: 'sync-schedules' })

    expect(logged).toHaveBeenCalledWith(
      JSON.stringify({
        job: 'sync-schedules',
        ok: true,
        jobs: [{ jobName: 'sync-schedules', ok: true, durationMs: 3 }],
      }),
    )
  })
})
