import { computeLeases, sessionSnapshots, workflowEvents } from '@bluetel-ai/sisyphus-api/db'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createFakeComputeProvisioner } from '../aws'
import { liveCredentialFor, mintScopedCredential } from '../credentials'

import { validationInstanceTag } from './instance-tag'
import { HEARTBEAT_LAPSE_MS, PROVISIONING_GRACE_MS, reconcile } from './reconcile'
import { createWorkflowFixtures, readTestDatabaseUrl } from './workflow-fixtures'

/**
 * FR-039 names two directions and this file tests both, but the tests that earn their place are
 * the four under "leaves a healthy run alone". A reconciler that kills healthy runs is worse than
 * one that leaks: a leak costs money and is caught by the next pass, while a wrongly-swept run
 * destroys work and reports a failure that never happened.
 *
 * Every test runs against `createFakeComputeProvisioner`, whose in-memory instance table answers
 * `listWorkflowInstances` consistently with the launches and terminations it was given — which is
 * what makes a two-directional sweep testable without an AWS account.
 */

const connectionString = readTestDatabaseUrl()
const describeWithDatabase = connectionString === undefined ? describe.skip : describe

const SECRET = 'test-signing-secret-not-a-real-one'
const NOW = new Date('2026-08-05T12:00:00.000Z')
const ago = (milliseconds: number): Date => new Date(NOW.getTime() - milliseconds)

/** See `admit-workflow.ts`: `noUncheckedIndexedAccess` is off, so indexing needs an honest type. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

describeWithDatabase('reconciling reality against recorded state', () => {
  const fixtures = createWorkflowFixtures(connectionString ?? '')

  beforeAll(() => fixtures.open(), 60_000)
  afterEach(() => fixtures.removeAll())
  afterAll(() => fixtures.close())

  /** A workflow holding a live lease, with the timings and instance the test needs. */
  const runHoldingCompute = async (options: {
    readonly label: string
    readonly state: 'failed' | 'paused' | 'provisioning' | 'running' | 'succeeded'
    readonly instanceId?: string | null
    readonly requestedAt?: Date
    readonly lastHeartbeatAt?: Date
  }): Promise<string> => {
    const workflowId = await fixtures.seedWorkflow({ label: options.label, state: options.state })

    await fixtures
      .db()
      .insert(computeLeases)
      .values({
        workflowId,
        instanceType: 'fixture.small',
        purchaseMode: 'spot',
        providerInstanceId:
          options.instanceId === null ? null : (options.instanceId ?? `i-${options.label}`),
        requestedAt: options.requestedAt ?? NOW,
        ...(options.lastHeartbeatAt === undefined
          ? {}
          : { lastHeartbeatAt: options.lastHeartbeatAt }),
      })

    await mintScopedCredential({ db: fixtures.db(), workflowId, secret: SECRET })

    return workflowId
  }

  const sweep = (compute = createFakeComputeProvisioner()) =>
    reconcile({ db: fixtures.db(), compute, now: () => NOW })

  describe('a lease with no live workflow — the leak that costs money silently', () => {
    it('releases the lease and destroys the instance of a finished run', async () => {
      const workflowId = await runHoldingCompute({ label: 'orphan', state: 'succeeded' })
      const compute = createFakeComputeProvisioner()
      compute.seedInstance({ instanceId: 'i-orphan', workflowId, state: 'running' })

      const result = await reconcile({ db: fixtures.db(), compute, now: () => NOW })

      expect(result.released).toHaveLength(1)
      expect(result.released[0]?.reason).toContain('lease outlived the run')
      expect(compute.terminations).toStrictEqual(['i-orphan'])

      const lease = firstRow(
        await fixtures
          .db()
          .select()
          .from(computeLeases)
          .where(eq(computeLeases.workflowId, workflowId)),
      )
      expect(lease?.releasedAt).not.toBeNull()
      expect(await liveCredentialFor(fixtures.db(), workflowId)).toBeUndefined()
    })

    it('destroys a tagged instance the database holds no live lease for', async () => {
      const compute = createFakeComputeProvisioner()
      // Never recorded: a launch that returned after the control plane crashed, say. Nothing else
      // in the platform will ever notice this instance.
      compute.seedInstance({
        instanceId: 'i-unrecorded',
        workflowId: '77777777-7777-7777-7777-777777777777',
        state: 'running',
      })

      const result = await sweep(compute)

      expect(result.terminated).toHaveLength(1)
      expect(result.terminated[0]).toMatchObject({ instanceId: 'i-unrecorded' })
      expect(compute.terminations).toStrictEqual(['i-unrecorded'])
    })

    it('destroys an instance carrying the platform tag with no value behind it', async () => {
      const compute = createFakeComputeProvisioner()
      compute.seedInstance({ instanceId: 'i-untagged', workflowId: undefined, state: 'running' })

      const result = await sweep(compute)

      expect(result.terminated[0]?.reason).toContain('no run behind it')
    })

    it('drains the queue once, after the release', async () => {
      await runHoldingCompute({ label: 'drain', state: 'succeeded' })
      let drains = 0

      await reconcile({
        db: fixtures.db(),
        compute: createFakeComputeProvisioner(),
        now: () => NOW,
        queueDrain: {
          drain: () => {
            drains += 1
            return Promise.resolve()
          },
        },
      })

      expect(drains).toBe(1)
    })
  })

  describe('a workflow whose lease vanished or heartbeat lapsed', () => {
    it('moves a run whose lease was released to failed, with the reason recorded', async () => {
      const workflowId = await fixtures.seedWorkflow({ label: 'no-lease', state: 'running' })

      const result = await sweep()

      expect(result.moved).toStrictEqual([
        {
          workflowId,
          from: 'running',
          to: 'failed',
          reason: 'the run holds no live compute lease, so the instance it was working on is gone',
        },
      ])
      expect(await fixtures.stateOf(workflowId)).toBe('failed')
    })

    it('moves a run whose instance has gone, naming the instance', async () => {
      const workflowId = await runHoldingCompute({
        label: 'gone',
        state: 'running',
        lastHeartbeatAt: NOW,
      })
      // The lease records `i-gone`; the sweep does not see it. Reclaimed spot capacity, usually.

      const result = await sweep()

      expect(result.moved[0]?.reason).toContain('i-gone is no longer running')
      expect(await fixtures.stateOf(workflowId)).toBe('failed')
    })

    it('moves a run whose heartbeat lapsed beyond the threshold', async () => {
      const workflowId = await runHoldingCompute({
        label: 'silent',
        state: 'running',
        lastHeartbeatAt: ago(HEARTBEAT_LAPSE_MS + 60_000),
      })
      const compute = createFakeComputeProvisioner()
      compute.seedInstance({ instanceId: 'i-silent', workflowId, state: 'running' })

      const result = await reconcile({ db: fixtures.db(), compute, now: () => NOW })

      expect(result.moved[0]?.reason).toContain('no heartbeat for')
      expect(await fixtures.stateOf(workflowId)).toBe('failed')
    })

    it('parks rather than fails a run with a resumable snapshot', async () => {
      const workflowId = await fixtures.seedWorkflow({ label: 'resumable', state: 'running' })
      await fixtures
        .db()
        .insert(sessionSnapshots)
        .values({
          workflowId,
          sessionId: crypto.randomUUID(),
          s3Key: `snapshots/${workflowId}/interrupt.tar.zst`,
          sizeBytes: 2048,
          boundary: 'interruption',
          hasConversationState: true,
          hasWorktreeState: true,
          isCurrent: true,
          expiresAt: new Date(NOW.getTime() + 86_400_000),
        })

      const result = await sweep()

      // SC-008: an interrupted run on interruptible capacity is recoverable, not failed. Failing
      // this one would throw away work that is sitting intact in durable storage.
      expect(result.moved[0]?.to).toBe('parked_resumable')
      expect(await fixtures.stateOf(workflowId)).toBe('parked_resumable')
    })

    it('fails rather than parks a run whose snapshot is missing a state flag', async () => {
      const workflowId = await fixtures.seedWorkflow({ label: 'half-snapshot', state: 'running' })
      await fixtures
        .db()
        .insert(sessionSnapshots)
        .values({
          workflowId,
          sessionId: crypto.randomUUID(),
          s3Key: `snapshots/${workflowId}/partial.tar.zst`,
          sizeBytes: 2048,
          boundary: 'interruption',
          hasConversationState: true,
          // FR-050: conversation state without the worktree is not resumable.
          hasWorktreeState: false,
          isCurrent: true,
          expiresAt: new Date(NOW.getTime() + 86_400_000),
        })

      expect((await sweep()).moved[0]?.to).toBe('failed')
    })

    it('records the move on the timeline, attributed to the reconciler', async () => {
      const workflowId = await fixtures.seedWorkflow({ label: 'timeline', state: 'running' })

      await sweep()

      const events = await fixtures
        .db()
        .select()
        .from(workflowEvents)
        .where(eq(workflowEvents.workflowId, workflowId))

      expect(events[0]).toMatchObject({ event: 'failed', actorType: 'reconciler' })
      expect(JSON.stringify(events[0]?.detail)).toContain('no live compute lease')
    })

    it('does not overwrite an outcome the executor reported while the pass was running', async () => {
      const workflowId = await runHoldingCompute({
        label: 'raced-terminal',
        state: 'succeeded',
        lastHeartbeatAt: ago(HEARTBEAT_LAPSE_MS + 60_000),
      })

      const result = await sweep()

      // FR-064 allows exactly one outcome in force, and the executor's own account beats an
      // inference drawn from a heartbeat that stopped because the run had finished.
      expect(result.moved).toStrictEqual([])
      expect(await fixtures.stateOf(workflowId)).toBe('succeeded')
    })
  })

  describe('leaves a healthy run alone', () => {
    it('does not sweep a run mid-provision that has never sent a heartbeat', async () => {
      const workflowId = await runHoldingCompute({
        label: 'provisioning',
        state: 'provisioning',
        requestedAt: ago(60_000),
      })
      const compute = createFakeComputeProvisioner()
      compute.seedInstance({ instanceId: 'i-provisioning', workflowId, state: 'pending' })

      const result = await reconcile({ db: fixtures.db(), compute, now: () => NOW })

      // Bootstrap phases 2–5 run before the executor can say anything. A sweep that read "no
      // heartbeat" as "dead" would destroy an instance partway through `setup.sh`.
      expect(result.moved).toStrictEqual([])
      expect(result.released).toStrictEqual([])
      expect(result.terminated).toStrictEqual([])
      expect(result.healthy).toBe(1)
      expect(await fixtures.stateOf(workflowId)).toBe('provisioning')
      expect(compute.terminations).toStrictEqual([])
    })

    it('does not sweep a run whose launch has not yet recorded an instance', async () => {
      // Admission takes the lease; the launch has not returned. The instance is genuinely absent
      // from the sweep, and reading that as "the instance is gone" would kill every run in the
      // seconds between admission and RunInstances answering.
      const workflowId = await runHoldingCompute({
        label: 'launching',
        state: 'provisioning',
        instanceId: null,
        requestedAt: ago(5_000),
      })

      const result = await sweep()

      expect(result.moved).toStrictEqual([])
      expect(await fixtures.stateOf(workflowId)).toBe('provisioning')
    })

    it('does not sweep a running workflow whose heartbeat is current', async () => {
      const workflowId = await runHoldingCompute({
        label: 'alive',
        state: 'running',
        lastHeartbeatAt: ago(30_000),
      })
      const compute = createFakeComputeProvisioner()
      compute.seedInstance({ instanceId: 'i-alive', workflowId, state: 'running' })

      const result = await reconcile({ db: fixtures.db(), compute, now: () => NOW })

      expect(result.moved).toStrictEqual([])
      expect(compute.terminations).toStrictEqual([])
    })

    it('sweeps a mid-provision run only once the grace period is spent', async () => {
      const workflowId = await runHoldingCompute({
        label: 'stuck',
        state: 'provisioning',
        requestedAt: ago(PROVISIONING_GRACE_MS + 60_000),
      })
      const compute = createFakeComputeProvisioner()
      compute.seedInstance({ instanceId: 'i-stuck', workflowId, state: 'running' })

      const result = await reconcile({ db: fixtures.db(), compute, now: () => NOW })

      expect(result.moved[0]?.reason).toContain('the instance never came up')
      // And the same pass releases the lease it has just orphaned, so the instance is gone inside
      // SC-007's ten minutes rather than after another cycle.
      expect(result.released).toHaveLength(1)
      expect(compute.terminations).toStrictEqual(['i-stuck'])
      expect(await fixtures.stateOf(workflowId)).toBe('failed')
    })

    it('leaves a bundle validation instance alone', async () => {
      const validationRunId = '88888888-8888-8888-8888-888888888888'
      const compute = createFakeComputeProvisioner()
      compute.seedInstance({
        instanceId: 'i-validation',
        workflowId: validationInstanceTag(validationRunId),
        state: 'running',
      })

      const result = await sweep(compute)

      // It holds no lease and matches no workflow, so a sweep that looked the tag up naively would
      // destroy it partway through `setup.sh` — the failure the tag prefix exists to prevent.
      expect(result.validationInstances).toStrictEqual(['i-validation'])
      expect(result.terminated).toStrictEqual([])
      expect(compute.terminations).toStrictEqual([])
    })
  })

  it('sweeps both directions in one pass', async () => {
    const finished = await runHoldingCompute({ label: 'both-finished', state: 'succeeded' })
    const abandoned = await fixtures.seedWorkflow({ label: 'both-abandoned', state: 'running' })
    const compute = createFakeComputeProvisioner()
    compute.seedInstance({ instanceId: 'i-both-finished', workflowId: finished, state: 'running' })

    const result = await reconcile({ db: fixtures.db(), compute, now: () => NOW })

    expect(result.released.map((lease) => lease.workflowId)).toStrictEqual([finished])
    expect(result.moved.map((move) => move.workflowId)).toStrictEqual([abandoned])
  })
})
