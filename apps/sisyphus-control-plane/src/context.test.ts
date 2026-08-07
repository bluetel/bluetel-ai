import type * as SisyphusDb from '@bluetel-ai/sisyphus-api/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ControlPlaneEnv } from './context'
import type * as Jobs from './jobs'

/**
 * Two seams are mocked and nothing else.
 *
 * `getDatabaseClient` would open a pool, and the queue drain would query one — everything else the
 * composition root builds is a client constructor, which reaches no account until something calls
 * `send`. So this file assembles the *real* context, asserts the wiring, and needs neither AWS
 * credentials nor Postgres to do it.
 */

const db = { handle: 'the-database' }
const getDatabaseClient = vi.fn(() => ({ db, sql: undefined, close: () => Promise.resolve() }))
const drainQueue = vi.fn(() => Promise.resolve())

vi.mock('@bluetel-ai/sisyphus-api/db', async (importOriginal) => ({
  ...(await importOriginal<typeof SisyphusDb>()),
  getDatabaseClient,
}))

vi.mock('./jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof Jobs>()),
  drainQueue,
}))

const { createControlPlaneContext } = await import('./context')
const { PROMPT_REDACTOR_NOT_CONFIGURED } = await import('./jobs')

const env = {
  DATABASE_URL: 'postgres://sisyphus@localhost:5432/sisyphus',
  SISYPHUS_BOOTSTRAP_ADMIN_EMAILS: ['admin@example.com'],
  SISYPHUS_MACHINE_SURFACE_URL: 'https://machine.example',
  SISYPHUS_MACHINE_CREDENTIAL_SECRET: 'machine-credential-secret',
  SISYPHUS_LOGS_BUCKET: 'sisyphus-test-logs',
  SISYPHUS_SNAPSHOTS_BUCKET: 'sisyphus-test-snapshots',
  SISYPHUS_BUNDLES_BUCKET: 'sisyphus-test-bundles',
  SISYPHUS_ARTIFACTS_BUCKET: 'sisyphus-test-artifacts',
  SISYPHUS_SCHEDULE_GROUP_NAME: 'sisyphus-test-schedules',
  SISYPHUS_SCHEDULER_TARGET_ARN: 'arn:aws:lambda:eu-west-2:1:function:control-plane',
  SISYPHUS_SCHEDULER_ROLE_ARN: 'arn:aws:iam::1:role/scheduler',
  SISYPHUS_EXECUTOR_AMI_ID: 'ami-0123456789',
  SISYPHUS_EXECUTOR_INSTANCE_PROFILE_ARN: 'arn:aws:iam::1:instance-profile/executor',
  SISYPHUS_EXECUTOR_SUBNET_IDS: ['subnet-a', 'subnet-b'],
  SISYPHUS_EXECUTOR_SECURITY_GROUP_IDS: ['sg-a'],
  SISYPHUS_SLACK_BOT_TOKEN: 'slack-bot-token-fixture',
  SISYPHUS_PANEL_URL: 'https://panel.example',
  SISYPHUS_CONCURRENCY_CEILING: 9,
  AWS_REGION: 'eu-west-2',
  SISYPHUS_STAGE: 'test',
} as ControlPlaneEnv

beforeEach(() => {
  getDatabaseClient.mockClear()
  drainQueue.mockClear()
})

describe('createControlPlaneContext', () => {
  it('supplies every port a job takes, so no route can reach an undefined dependency', () => {
    expect(Object.keys(createControlPlaneContext({ env })).sort()).toStrictEqual([
      'bootstrapAdminEmails',
      'buckets',
      'ceiling',
      'compute',
      'connectors',
      'credentialSecret',
      'db',
      'machineSurfaceUrl',
      'notifier',
      'objectStore',
      'queueDrain',
      'readCredential',
      'redactor',
      'schedules',
      'starter',
    ])
  })

  it('takes the ceiling, the buckets and the credentials from the validated environment', () => {
    const context = createControlPlaneContext({ env })

    expect(context.ceiling).toBe(9)
    expect(context.buckets).toStrictEqual({
      logs: 'sisyphus-test-logs',
      artifacts: 'sisyphus-test-artifacts',
      snapshots: 'sisyphus-test-snapshots',
    })
    expect(context.machineSurfaceUrl).toBe('https://machine.example')
    expect(context.credentialSecret).toBe('machine-credential-secret')
    expect(context.bootstrapAdminEmails).toStrictEqual(['admin@example.com'])
  })

  it('opens no pool at import, and takes the memoised one when called', () => {
    expect(getDatabaseClient).not.toHaveBeenCalled()

    expect(createControlPlaneContext({ env }).db).toBe(db)

    expect(getDatabaseClient).toHaveBeenCalledWith({
      connectionString: 'postgres://sisyphus@localhost:5432/sisyphus',
    })
  })

  it('registers the connectors this deployment can actually tick (FR-192)', () => {
    expect(createControlPlaneContext({ env }).connectors.types()).toStrictEqual(['jira'])
  })

  it('defaults to a redactor that refuses, rather than storing an unredacted ticket (FR-163)', () => {
    const { redactor } = createControlPlaneContext({ env })

    expect(() => redactor.redact('anything at all')).toThrow(PROMPT_REDACTOR_NOT_CONFIGURED)
  })

  it('drains through the same ceiling and starter the drain event would use', async () => {
    const context = createControlPlaneContext({ env })

    await context.queueDrain.drain()

    expect(drainQueue).toHaveBeenCalledWith({ db, ceiling: 9, starter: context.starter })
  })

  it('gives the drain a starter that provisions, rather than a second seam to wire', () => {
    expect(createControlPlaneContext({ env }).starter.start).toBeTypeOf('function')
  })

  it('builds the notifier from the Slack token and the panel URL, so no job holds either', () => {
    // Constructing a `WebClient` opens nothing, so this reaches no workspace — the same argument
    // the AWS client constructors above rest on.
    const { notifier } = createControlPlaneContext({ env })

    expect(notifier.workflowEvent).toBeTypeOf('function')
    expect(notifier.integrationTick).toBeTypeOf('function')
  })

  it('uses a supplied port verbatim, which is how a deployment wires its own redactor', () => {
    const redactor = { redact: (text: string) => text.toUpperCase() }
    const readCredential = () => Promise.resolve('credential')

    const context = createControlPlaneContext({ env, redactor, readCredential })

    expect(context.redactor).toBe(redactor)
    expect(context.readCredential).toBe(readCredential)
  })

  it('never opens a pool when the handle is supplied', () => {
    const supplied = { handle: 'supplied' } as unknown as ReturnType<
      typeof createControlPlaneContext
    >['db']

    expect(createControlPlaneContext({ env, db: supplied }).db).toBe(supplied)
    expect(getDatabaseClient).not.toHaveBeenCalled()
  })
})
