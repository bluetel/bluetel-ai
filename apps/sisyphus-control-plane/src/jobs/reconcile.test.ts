import type { Workflow } from '@bluetel-ai/sisyphus-api/db'
import {
  computeLeases,
  sessionSnapshots,
  workflowEvents,
  workflows,
} from '@bluetel-ai/sisyphus-api/db'
import { createFakeWorkflowNotifier } from '@bluetel-ai/sisyphus-notify'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createFakeComputeProvisioner } from '../aws'
import { liveCredentialFor, mintScopedCredential } from '../credentials'
import { createCredentialPoolFixtures } from '../credentials/allocate/pool-fixtures'

import { admitWorkflow } from './admit-workflow'
import { validationInstanceTag } from './instance-tag'
import type { ReconcileResult } from './reconcile'
import {
  HEARTBEAT_LAPSE_MS,
  PAUSE_IDLE_CEILING_MS,
  PAUSE_IDLE_GRACE_MS,
  PROVISIONING_GRACE_MS,
  reconcile,
} from './reconcile'
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

  /**
   * The `paused` timeline row `acknowledgeSupervisionCommand` writes, at a chosen moment.
   *
   * This is where the reconciler reads `paused_at` from — there is no such column, and the sweep
   * deliberately depends on the fact the platform already records rather than on a second copy of
   * it. Seeding it by hand is therefore seeding the real evidence, not a stand-in for it.
   */
  const seedPauseEvent = async (workflowId: string, at: Date): Promise<void> => {
    await fixtures.db().insert(workflowEvents).values({
      workflowId,
      event: 'paused',
      actorType: 'executor',
      createdAt: at,
    })
  }

  /** A resumable snapshot, as FR-049 leaves one behind before a pause is ever acknowledged. */
  const seedPauseSnapshot = async (workflowId: string): Promise<void> => {
    await fixtures
      .db()
      .insert(sessionSnapshots)
      .values({
        workflowId,
        sessionId: crypto.randomUUID(),
        s3Key: `snapshots/${workflowId}/pause.tar.zst`,
        sizeBytes: 2048,
        boundary: 'pause',
        hasConversationState: true,
        hasWorktreeState: true,
        isCurrent: true,
        expiresAt: new Date(NOW.getTime() + 86_400_000),
      })
  }

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

    it('sweeps a paused run whose heartbeat lapsed, like any other state holding compute', async () => {
      // The other arm of `ACTIVE_STATES`' third member: a paused run is swept on the same evidence
      // as a running one, because a pause holds the instance and a silent pause is still a leak.
      const workflowId = await runHoldingCompute({
        label: 'paused-silent',
        state: 'paused',
        lastHeartbeatAt: ago(HEARTBEAT_LAPSE_MS + 60_000),
      })
      const compute = createFakeComputeProvisioner()
      compute.seedInstance({ instanceId: 'i-paused-silent', workflowId, state: 'running' })

      const result = await reconcile({ db: fixtures.db(), compute, now: () => NOW })

      expect(result.moved[0]).toMatchObject({ workflowId, from: 'paused', to: 'failed' })
      expect(await fixtures.stateOf(workflowId)).toBe('failed')
    })

    /**
     * **The pause idle ceiling (T181, FR-049, US2 §4, quickstart 5.6).**
     *
     * A run in this state passes every other check in the sweep: live lease, live instance,
     * current heartbeat. It is healthy in every sense except the one that matters — nobody is ever
     * coming back to it, and it is billing an instance to wait. Before T181 nothing anywhere
     * looked at the clock, so `'on-idle-ceiling'` meant "hold this instance for ever".
     */
    it('parks a pause nobody came back to, and releases its instance in the same pass', async () => {
      const workflowId = await runHoldingCompute({
        label: 'paused-forgotten',
        state: 'paused',
        // Healthy on every other measure: the executor is alive and beating, it just has nothing
        // to do. That is what makes the clock the only evidence there is.
        lastHeartbeatAt: ago(30_000),
      })
      await seedPauseEvent(workflowId, ago(PAUSE_IDLE_CEILING_MS + PAUSE_IDLE_GRACE_MS + 60_000))
      await seedPauseSnapshot(workflowId)
      const compute = createFakeComputeProvisioner()
      compute.seedInstance({ instanceId: 'i-paused-forgotten', workflowId, state: 'running' })

      const result = await reconcile({ db: fixtures.db(), compute, now: () => NOW })

      // Parked, not failed. FR-049 registers a snapshot before a pause is ever acknowledged, so a
      // paused run is a resumable run by construction and failing it would throw away work that
      // is sitting intact in durable storage.
      expect(result.moved[0]).toMatchObject({
        workflowId,
        from: 'paused',
        to: 'parked_resumable',
      })
      expect(result.moved[0]?.reason).toContain('pause idle ceiling')
      expect(await fixtures.stateOf(workflowId)).toBe('parked_resumable')

      // "Its instance is released" is half of US2 §4, and it happens in this pass rather than the
      // next one because the lease sweep re-reads after the moves.
      expect(compute.terminations).toStrictEqual(['i-paused-forgotten'])
      expect(result.released).toHaveLength(1)
    })

    it('tells the owner it was parked rather than leaving them to notice (FR-136)', async () => {
      const workflowId = await runHoldingCompute({
        label: 'paused-announced',
        state: 'paused',
        lastHeartbeatAt: ago(30_000),
      })
      await seedPauseEvent(workflowId, ago(PAUSE_IDLE_CEILING_MS + PAUSE_IDLE_GRACE_MS + 60_000))
      await seedPauseSnapshot(workflowId)
      const compute = createFakeComputeProvisioner()
      compute.seedInstance({ instanceId: 'i-paused-announced', workflowId, state: 'running' })
      const notifier = createFakeWorkflowNotifier()

      await reconcile({ db: fixtures.db(), compute, now: () => NOW, notifier })

      expect(notifier.notices[0]).toMatchObject({
        workflowId,
        event: 'workflow_parked_resumable',
      })
    })

    it('records the expiry on the timeline, so "why did this park?" has an answer', async () => {
      const workflowId = await runHoldingCompute({
        label: 'paused-timeline',
        state: 'paused',
        lastHeartbeatAt: ago(30_000),
      })
      await seedPauseEvent(workflowId, ago(PAUSE_IDLE_CEILING_MS + PAUSE_IDLE_GRACE_MS + 60_000))
      await seedPauseSnapshot(workflowId)
      const compute = createFakeComputeProvisioner()
      compute.seedInstance({ instanceId: 'i-paused-timeline', workflowId, state: 'running' })

      await reconcile({ db: fixtures.db(), compute, now: () => NOW })

      const events = await fixtures
        .db()
        .select()
        .from(workflowEvents)
        .where(eq(workflowEvents.workflowId, workflowId))

      const parked = events.find((event) => event.event === 'parked')
      expect(parked).toMatchObject({ actorType: 'reconciler' })
      expect(JSON.stringify(parked?.detail)).toContain('pause idle ceiling')
    })

    it('honours a configured ceiling rather than only the default', async () => {
      const workflowId = await runHoldingCompute({
        label: 'paused-configured',
        state: 'paused',
        lastHeartbeatAt: ago(10_000),
      })
      await seedPauseEvent(workflowId, ago(5_000))
      const compute = createFakeComputeProvisioner()
      compute.seedInstance({ instanceId: 'i-paused-configured', workflowId, state: 'running' })

      const result = await reconcile({
        db: fixtures.db(),
        compute,
        now: () => NOW,
        pauseIdleCeilingMs: 1_000,
        pauseIdleGraceMs: 1_000,
      })

      expect(result.moved[0]).toMatchObject({ workflowId, from: 'paused' })
    })

    it('reports a vanished instance as vanished, not as an expired pause', async () => {
      // Both are true of this run and only one of them is the useful thing to tell its owner.
      // Reporting the ceiling would say the platform tidied up in an orderly way when in fact the
      // machine went away underneath it, which is a different problem with a different fix.
      const workflowId = await runHoldingCompute({
        label: 'paused-and-gone',
        state: 'paused',
        instanceId: 'i-paused-and-gone',
      })
      await seedPauseEvent(workflowId, ago(PAUSE_IDLE_CEILING_MS + PAUSE_IDLE_GRACE_MS + 60_000))

      const result = await sweep()

      expect(result.moved[0]?.reason).toContain('no longer running')
      expect(result.moved[0]?.reason).not.toContain('idle ceiling')
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
    it('does not sweep a run waiting for an agent credential (003/FR-024, FR-025)', async () => {
      // The trap in adding `awaiting_credential` to the platform's vocabulary. A waiting run holds
      // no compute lease *by design* — that is the entire point of the state, and SC-004 measures
      // it — so a sweep that judged it by the "no live compute lease" rule above would fail every
      // waiter on the first pass after it started waiting, telling its owner that an instance it
      // was never given had gone away. The FR-028 limit is what ends a wait, and it lives in
      // `drain-queue.ts` with the clock and the reason.
      const workflowId = await fixtures.seedWorkflow({
        label: 'waiting-for-credential',
        state: 'awaiting_credential',
      })

      const result = await sweep()

      expect(result.moved).toStrictEqual([])
      expect(await fixtures.stateOf(workflowId)).toBe('awaiting_credential')
      // Nor counted as healthy: this direction does not look at it at all.
      expect(result.healthy).toBe(0)
    })

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

    it('does not sweep a paused run whose heartbeat is current', async () => {
      // `paused` is in `ACTIVE_STATES` because a paused run still holds its instance — that is the
      // whole point of pausing rather than parking. Without this seed the third arm of that list
      // was never exercised: the sweep would have had to *skip* paused runs for the suite to
      // notice, and a sweep that killed them would have passed.
      const workflowId = await runHoldingCompute({
        label: 'paused-alive',
        state: 'paused',
        lastHeartbeatAt: ago(30_000),
      })
      const compute = createFakeComputeProvisioner()
      compute.seedInstance({ instanceId: 'i-paused-alive', workflowId, state: 'running' })

      const result = await reconcile({ db: fixtures.db(), compute, now: () => NOW })

      expect(result.moved).toStrictEqual([])
      expect(result.healthy).toBe(1)
      expect(await fixtures.stateOf(workflowId)).toBe('paused')
      expect(compute.terminations).toStrictEqual([])
    })

    it('does not sweep a paused run that is still inside the idle ceiling', async () => {
      const workflowId = await runHoldingCompute({
        label: 'paused-recent',
        state: 'paused',
        lastHeartbeatAt: ago(30_000),
      })
      await seedPauseEvent(workflowId, ago(PAUSE_IDLE_CEILING_MS - 60_000))
      const compute = createFakeComputeProvisioner()
      compute.seedInstance({ instanceId: 'i-paused-recent', workflowId, state: 'running' })

      const result = await reconcile({ db: fixtures.db(), compute, now: () => NOW })

      expect(result.moved).toStrictEqual([])
      expect(await fixtures.stateOf(workflowId)).toBe('paused')
      expect(compute.terminations).toStrictEqual([])
    })

    it('does not sweep a paused run with no timeline row saying when the pause began', async () => {
      // No evidence, no action — the same rule the heartbeat checks apply. A run whose pause
      // predates the timeline entry must not be parked on a guess about how long it has been sat
      // there, because the guess would be "since the beginning of time".
      const workflowId = await runHoldingCompute({
        label: 'paused-undated',
        state: 'paused',
        lastHeartbeatAt: ago(30_000),
      })
      const compute = createFakeComputeProvisioner()
      compute.seedInstance({ instanceId: 'i-paused-undated', workflowId, state: 'running' })

      const result = await reconcile({ db: fixtures.db(), compute, now: () => NOW })

      expect(result.moved).toStrictEqual([])
      expect(result.healthy).toBe(1)
      expect(await fixtures.stateOf(workflowId)).toBe('paused')
    })

    it('does not sweep a paused run whose latest event is a resume', async () => {
      // Paused, resumed, paused again — a long time ago and then a moment ago. The current pause
      // is the latest `paused` row, and reading the *first* one would park a run somebody is
      // actively working with.
      const workflowId = await runHoldingCompute({
        label: 'paused-again',
        state: 'paused',
        lastHeartbeatAt: ago(10_000),
      })
      await seedPauseEvent(workflowId, ago(PAUSE_IDLE_CEILING_MS * 4))
      await seedPauseEvent(workflowId, ago(30_000))
      const compute = createFakeComputeProvisioner()
      compute.seedInstance({ instanceId: 'i-paused-again', workflowId, state: 'running' })

      const result = await reconcile({ db: fixtures.db(), compute, now: () => NOW })

      expect(result.moved).toStrictEqual([])
      expect(await fixtures.stateOf(workflowId)).toBe('paused')
    })

    it('does not sweep a paused run inside the grace the executor is given to act first', async () => {
      // The instance is meant to hand itself back at the ceiling. The grace is what stops this
      // sweep racing that and having two authors write one run's outcome.
      const workflowId = await runHoldingCompute({
        label: 'paused-grace',
        state: 'paused',
        lastHeartbeatAt: ago(10_000),
      })
      await seedPauseEvent(workflowId, ago(PAUSE_IDLE_CEILING_MS + PAUSE_IDLE_GRACE_MS - 60_000))
      const compute = createFakeComputeProvisioner()
      compute.seedInstance({ instanceId: 'i-paused-grace', workflowId, state: 'running' })

      expect((await reconcile({ db: fixtures.db(), compute, now: () => NOW })).moved).toStrictEqual(
        [],
      )
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

  describe('tells the owner their run was swept (T177, FR-136, FR-141)', () => {
    // Every test here goes through the recording notifier, so the suite reaches no Slack workspace
    // — see `notify/slack-fake.ts` on why no test in this repository ever does.

    it('announces workflow_failed for a run whose compute vanished', async () => {
      const workflowId = await fixtures.seedWorkflow({ label: 'tell-failed', state: 'running' })
      const notifier = createFakeWorkflowNotifier()

      const result = await reconcile({
        db: fixtures.db(),
        compute: createFakeComputeProvisioner(),
        now: () => NOW,
        notifier,
      })

      expect(notifier.notices).toStrictEqual([{ workflowId, event: 'workflow_failed' }])
      expect(result.notificationErrors).toStrictEqual([])
    })

    it('announces workflow_parked_resumable for a run it parked rather than failed', async () => {
      const workflowId = await fixtures.seedWorkflow({ label: 'tell-parked', state: 'running' })
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
      const notifier = createFakeWorkflowNotifier()

      await reconcile({
        db: fixtures.db(),
        compute: createFakeComputeProvisioner(),
        now: () => NOW,
        notifier,
      })

      // The event follows the destination, not the trigger: the run is recoverable and saying it
      // failed would send its owner to write off work that is sitting intact in S3.
      expect(notifier.notices).toStrictEqual([{ workflowId, event: 'workflow_parked_resumable' }])
    })

    it('announces once per run moved, and nothing for a run it left alone', async () => {
      const abandoned = await fixtures.seedWorkflow({ label: 'tell-one', state: 'running' })
      const healthy = await runHoldingCompute({
        label: 'tell-none',
        state: 'running',
        lastHeartbeatAt: ago(30_000),
      })
      const compute = createFakeComputeProvisioner()
      compute.seedInstance({ instanceId: 'i-tell-none', workflowId: healthy, state: 'running' })
      const notifier = createFakeWorkflowNotifier()

      await reconcile({ db: fixtures.db(), compute, now: () => NOW, notifier })

      expect(notifier.notices).toStrictEqual([{ workflowId: abandoned, event: 'workflow_failed' }])
    })

    it('announces nothing for a lease released under a run that was already terminal', async () => {
      // Releasing a lease is not a state change: the run reached `succeeded` elsewhere and was
      // announced there. A notification here would be a second message about the same outcome.
      await runHoldingCompute({ label: 'tell-released', state: 'succeeded' })
      const notifier = createFakeWorkflowNotifier()

      const result = await reconcile({
        db: fixtures.db(),
        compute: createFakeComputeProvisioner(),
        now: () => NOW,
        notifier,
      })

      expect(result.released).toHaveLength(1)
      expect(notifier.notices).toStrictEqual([])
    })

    it('sweeps exactly as it would have done when the notification fails (FR-141)', async () => {
      const workflowId = await fixtures.seedWorkflow({ label: 'tell-broken', state: 'running' })
      const notifier = createFakeWorkflowNotifier({ failure: new Error('slack is unreachable') })

      const result = await reconcile({
        db: fixtures.db(),
        compute: createFakeComputeProvisioner(),
        now: () => NOW,
        notifier,
      })

      // The move stands and is reported; the delivery failure is reported *beside* it. A run that
      // was correctly swept and could not be announced is a swept run with a failed notification.
      expect(result.moved.map((move) => move.workflowId)).toStrictEqual([workflowId])
      expect(await fixtures.stateOf(workflowId)).toBe('failed')
      expect(result.notificationErrors.map((error) => error.message)).toStrictEqual([
        'slack is unreachable',
      ])
    })

    it('sweeps without a notifier at all, because announcing is not the sweeps purpose', async () => {
      const workflowId = await fixtures.seedWorkflow({ label: 'tell-nobody', state: 'running' })

      const result = await sweep()

      expect(result.moved.map((move) => move.workflowId)).toStrictEqual([workflowId])
      expect(result.notificationErrors).toStrictEqual([])
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

/**
 * FR-022 — the stranded-seat sweep (T049).
 *
 * The assertion that matters most in this file is the negative one: **the sweep does not touch a
 * lease held by a `paused` or `parked_resumable` workflow.** Getting it wrong silently steals seats
 * from runs that are legitimately holding them, and it is the easy mistake to make, because
 * `parked_resumable` is a terminal outcome — so the naive "is the run over?" test that is right for
 * a compute lease is wrong here.
 *
 * The positives are the ones SC-015 is phrased over: a live lease whose workflow is terminal, or
 * gone, is released within one interval, as `forced`, attributed to the sweep and not to a person.
 */
describeWithDatabase('sweeping seats no run is left to hand back (FR-022, SC-015)', () => {
  const pool = createCredentialPoolFixtures(connectionString ?? '')

  beforeAll(() => pool.open(), 60_000)
  afterAll(() => pool.close())

  afterEach(async () => {
    await pool.db().delete(computeLeases)
    // The FK first, then the rows: `workflows.current_snapshot_id` points at what the retention
    // tests seed, and the sweep under test reads exactly that column.
    await pool.db().update(workflows).set({ currentSnapshotId: null })
    await pool.db().delete(sessionSnapshots)
    await pool.clearLeases()
  })

  /**
   * Give a run a current snapshot that stops being retained at the given instant.
   *
   * `expires_at` is the whole of FR-073's second clause: it is the moment a parked run stops being
   * resumable, and therefore the moment the seat it was holding for a resume is holding it for
   * nothing.
   */
  const snapshotExpiring = async (workflowId: string, expiresAt: Date): Promise<void> => {
    const snapshot = firstRow(
      await pool
        .db()
        .insert(sessionSnapshots)
        .values({
          workflowId,
          sessionId: crypto.randomUUID(),
          s3Key: `snapshots/${workflowId}/park.tar.zst`,
          sizeBytes: 4_096,
          boundary: 'pause',
          hasConversationState: true,
          hasWorktreeState: true,
          isCurrent: true,
          expiresAt,
        })
        .returning({ id: sessionSnapshots.id }),
    )

    await pool
      .db()
      .update(workflows)
      .set({ currentSnapshotId: snapshot?.id ?? null })
      .where(eq(workflows.id, workflowId))
  }

  /** A run in the given state, holding a seat taken through the real admission path. */
  const runHoldingASeat = async (options: {
    readonly label: string
    readonly state: Workflow['state']
  }): Promise<{ readonly workflowId: string; readonly agentCredentialId: string }> => {
    const credentialGroupId = await pool.seedGroup({ label: `${options.label}-group` })
    const agentCredentialId = await pool.seedCredential({
      label: `${options.label}-cred`,
      credentialGroupId,
    })
    const executionProfileId = await pool.seedProfile({
      label: `${options.label}-profile`,
      groups: [{ credentialGroupId, position: 1 }],
    })
    const workflowId = await pool.seedWorkflow({
      label: options.label,
      executionProfileId,
      state: 'queued',
    })

    // Through admission, so the seat under test is one the production path took — and the compute
    // lease it takes is deliberately left in place: a live run without one reads to direction two
    // as a run whose instance vanished, and this suite would then be testing that path instead.
    await admitWorkflow({ db: pool.db(), workflowId, ceiling: 16 })
    await pool
      .db()
      .update(workflows)
      .set({ state: options.state })
      .where(eq(workflows.id, workflowId))

    return { workflowId, agentCredentialId }
  }

  const sweep = async (): Promise<ReconcileResult> =>
    reconcile({ db: pool.db(), compute: createFakeComputeProvisioner(), now: () => NOW })

  it('does not touch a seat held by a paused or parked workflow', async () => {
    // The assertion this whole task turns on. A pause holds its instance and a park holds its
    // identity so FR-151 can resume onto it; both are live claims by design, and `parked_resumable`
    // is nevertheless a terminal outcome, so a sweep judging by
    // the terminal enum alone takes both.
    const paused = await runHoldingASeat({ label: 'sweep-paused', state: 'paused' })
    const parked = await runHoldingASeat({ label: 'sweep-parked', state: 'parked_resumable' })

    const result = await sweep()

    expect(result.releasedSeats).toStrictEqual([])
    expect(await pool.liveLeases()).toHaveLength(2)
    expect(await pool.credential(paused.agentCredentialId)).toMatchObject({ state: 'held' })
    expect(await pool.credential(parked.agentCredentialId)).toMatchObject({ state: 'held' })

    // And nothing was written about either: a `force_released` entry for a seat still held would be
    // worse than the silence, because it would be a trail that cannot be believed.
    expect(await pool.auditFor(paused.agentCredentialId)).toMatchObject([{ action: 'leased' }])
    expect(await pool.auditFor(parked.agentCredentialId)).toMatchObject([{ action: 'leased' }])
  }, 60_000)

  it('releases the seat of a parked run whose snapshot passed its retention period (FR-073)', async () => {
    // The one path by which a parked run's seat comes back. Nothing else is looking: the run is
    // already terminal, so no state change is coming and no executor is left to report one, and the
    // pool view would go on showing a `parked` holder for a resume that can never happen.
    const { agentCredentialId, workflowId } = await runHoldingASeat({
      label: 'park-expired',
      state: 'parked_resumable',
    })
    await snapshotExpiring(workflowId, ago(60_000))

    const result = await sweep()

    expect(result.releasedSeats).toMatchObject([
      {
        workflowId,
        agentCredentialId,
        workflowState: 'parked_resumable',
        credentialState: 'available',
      },
    ])
    expect(result.releasedSeats[0].reason).toContain('stopped being retained')

    // The run's own state is left exactly where it was. `parked_resumable` is already the outcome
    // in force and FR-064 allows one; rewriting it to `failed` would recast a run that parked in an
    // orderly way as one that broke. What changed is that the platform stopped holding the option.
    expect(
      firstRow(
        await pool
          .db()
          .select({ state: workflows.state })
          .from(workflows)
          .where(eq(workflows.id, workflowId)),
      ),
    ).toMatchObject({ state: 'parked_resumable' })
    expect(await pool.credential(agentCredentialId)).toMatchObject({
      state: 'available',
      heldBy: null,
    })
  }, 60_000)

  it('keeps the seat of a parked run whose snapshot is still retained', async () => {
    // The other half of FR-073, and the half that costs a seat: while the snapshot is retained the
    // run can still be resumed, and it must resume under the identity it already holds (SC-018).
    const { agentCredentialId, workflowId } = await runHoldingASeat({
      label: 'park-retained',
      state: 'parked_resumable',
    })
    await snapshotExpiring(workflowId, new Date(NOW.getTime() + 60_000))

    const result = await sweep()

    expect(result.releasedSeats).toStrictEqual([])
    expect(await pool.credential(agentCredentialId)).toMatchObject({ state: 'held' })
  }, 60_000)

  it('does not touch a seat held by a run that is still alive, in any state', async () => {
    // `awaiting_credential` is the one worth naming: a seat just granted to a waiter is a live
    // lease whose workflow is not yet `provisioning`, and a sweep reading that as "not running"
    // would take back the grant it had come to make possible.
    const waiting = await runHoldingASeat({
      label: 'sweep-waiting',
      state: 'awaiting_credential',
    })
    const running = await runHoldingASeat({ label: 'sweep-running', state: 'running' })

    const result = await sweep()

    expect(result.releasedSeats).toStrictEqual([])
    expect(await pool.credential(waiting.agentCredentialId)).toMatchObject({ state: 'held' })
    expect(await pool.credential(running.agentCredentialId)).toMatchObject({ state: 'held' })
  }, 60_000)

  it('releases a seat whose run is terminal, as `forced` and attributed to the sweep', async () => {
    const { workflowId, agentCredentialId } = await runHoldingASeat({
      label: 'sweep-failed',
      state: 'failed',
    })

    const result = await sweep()

    expect(result.releasedSeats).toMatchObject([
      { workflowId, agentCredentialId, workflowState: 'failed', credentialState: 'available' },
    ])
    expect(result.releasedSeats[0].reason).toContain('the seat outlived the run')

    // The attribution. FR-057 records an administrator's force-release against that administrator;
    // this is the platform tidying up after a run that is not there to do it, and the null actor on
    // the `force_released` entry is exactly what distinguishes the two (FR-058, SC-015).
    expect(await pool.auditFor(agentCredentialId)).toMatchObject([
      { action: 'leased', actorUserId: null },
      { action: 'force_released', actorUserId: null, detail: { releaseReason: 'forced' } },
    ])

    const [lease] = await pool.leases()
    expect(lease).toMatchObject({ releaseReason: 'forced', releasedByUserId: null })
    expect(await pool.credential(agentCredentialId)).toMatchObject({
      state: 'available',
      heldBy: null,
    })
  }, 60_000)

  it('releases a seat in the same pass that declared its run dead, not the next one', async () => {
    // SC-015 is phrased in reconciliation intervals, so a seat freed one pass later than the run it
    // belonged to would be a seat held for twice as long as the criterion allows.
    const credentialGroupId = await pool.seedGroup({ label: 'same-pass-group' })
    const agentCredentialId = await pool.seedCredential({
      label: 'same-pass-cred',
      credentialGroupId,
    })
    const executionProfileId = await pool.seedProfile({
      label: 'same-pass-profile',
      groups: [{ credentialGroupId, position: 1 }],
    })
    const workflowId = await pool.seedWorkflow({
      label: 'same-pass',
      executionProfileId,
      state: 'queued',
    })

    await admitWorkflow({ db: pool.db(), workflowId, ceiling: 16 })
    await pool
      .db()
      .update(computeLeases)
      .set({ providerInstanceId: 'i-same-pass', requestedAt: ago(PROVISIONING_GRACE_MS * 2) })
      .where(eq(computeLeases.workflowId, workflowId))
    await pool
      .db()
      .update(workflows)
      .set({ state: 'provisioning' })
      .where(eq(workflows.id, workflowId))

    // The instance never came up: direction two fails the run, direction one releases its compute,
    // and the seat sweep — which runs last, on a re-read — catches it in the same pass.
    const result = await sweep()

    expect(result.moved.map((move) => move.to)).toStrictEqual(['failed'])
    expect(result.releasedSeats.map((seat) => seat.agentCredentialId)).toStrictEqual([
      agentCredentialId,
    ])
    expect(await pool.credential(agentCredentialId)).toMatchObject({ state: 'available' })
  }, 60_000)

  it('does not repair a credential that fell ill while it was held (FR-033)', async () => {
    const { agentCredentialId } = await runHoldingASeat({
      label: 'sweep-unwell',
      state: 'cancelled',
    })

    await pool.execute(
      `update agent_credentials set state = 'cooling_off' where id = '${agentCredentialId}'`,
    )

    const result = await sweep()

    // Freed, but no capacity added — which is why the seat's own record carries the state it landed
    // in rather than leaving a reader to infer `available` from the word "released".
    expect(result.releasedSeats).toMatchObject([
      { agentCredentialId, credentialState: 'cooling_off' },
    ])
    expect(await pool.credential(agentCredentialId)).toMatchObject({ state: 'cooling_off' })
  }, 60_000)

  it('drains the queue after freeing a seat, even when it freed no compute', async () => {
    // A seat is capacity as much as a slot is, and Phase 6's grant path hangs off the drain — so a
    // pass that released only seats still has a queue worth re-examining.
    const { workflowId } = await runHoldingASeat({ label: 'sweep-drain', state: 'succeeded' })
    // No compute to free, so the only thing this pass can hand back is the seat.
    await pool.db().delete(computeLeases).where(eq(computeLeases.workflowId, workflowId))
    let drained = 0

    const result = await reconcile({
      db: pool.db(),
      compute: createFakeComputeProvisioner(),
      now: () => NOW,
      queueDrain: {
        drain: () => {
          drained += 1
          return Promise.resolve()
        },
      },
    })

    expect(result.released).toStrictEqual([])
    expect(result.releasedSeats).toHaveLength(1)
    expect(drained).toBe(1)
  }, 60_000)

  it('is idempotent across passes, freeing each seat exactly once', async () => {
    const { agentCredentialId } = await runHoldingASeat({
      label: 'sweep-twice',
      state: 'succeeded',
    })

    await sweep()
    const second = await sweep()

    // The sweep runs on a timer. A second release would append a second `force_released` entry, or
    // free a seat some later run had since been granted.
    expect(second.releasedSeats).toStrictEqual([])
    expect(await pool.auditFor(agentCredentialId)).toHaveLength(2)
  }, 60_000)
})

/**
 * **T086 — the cooling-off return sweep (003/FR-076, FR-078, SC-019).**
 *
 * `cooling_off` is the one credential state that is supposed to end without anybody doing anything,
 * and this is the thing that ends it. Two populations, and the second is the one that would
 * otherwise be lost for ever: a provider that refuses a quota **without saying when it clears**
 * leaves nothing to wait on, and a null `cooling_off_until` read as "wait until told" is a seat that
 * never comes back. FR-078 forbids exactly that.
 *
 * The negative assertions are the interesting ones here, as they were for the seat sweep above. A
 * credential still cooling off must not be returned early, a credential a run is waiting on must
 * come back as `held` rather than into the pool, and `unhealthy` must be left entirely alone —
 * returning a broken login to service on a timer is how SC-010 is lost.
 */
describeWithDatabase('returning cooling-off seats to the pool (FR-076, FR-078)', () => {
  const pool = createCredentialPoolFixtures(connectionString ?? '')

  let groupId = ''

  beforeAll(async () => {
    await pool.open()
    groupId = await pool.seedGroup({ label: 'cooling' })
  }, 60_000)

  afterAll(() => pool.close())

  afterEach(async () => {
    await pool.clearLeases()
    await pool.execute('delete from agent_credentials')
  })

  const sweep = async (coolingOffRetryMs?: number): Promise<ReconcileResult> =>
    reconcile({
      db: pool.db(),
      compute: createFakeComputeProvisioner(),
      now: () => NOW,
      ...(coolingOffRetryMs === undefined ? {} : { coolingOffRetryMs }),
    })

  it('returns a credential past the reset time the provider stated', async () => {
    const agentCredentialId = await pool.seedCredential({
      label: 'stated-elapsed',
      credentialGroupId: groupId,
      state: 'cooling_off',
      coolingOffUntil: ago(60_000),
    })

    const result = await sweep()

    expect(result.returnedToPool).toStrictEqual([
      {
        agentCredentialId,
        returnedBecause: 'stated',
        returnedTo: 'available',
        reason: expect.stringContaining('stated limit cleared') as string,
      },
    ])
    expect(await pool.credential(agentCredentialId)).toMatchObject({
      state: 'available',
      coolingOffUntil: null,
    })
  }, 60_000)

  it('leaves a credential whose stated limit has not cleared', async () => {
    const agentCredentialId = await pool.seedCredential({
      label: 'stated-pending',
      credentialGroupId: groupId,
      state: 'cooling_off',
      coolingOffUntil: new Date(NOW.getTime() + 600_000),
    })

    const result = await sweep()

    // Returning it early would offer the seat to a workflow the provider is still refusing, which
    // is a failed run with nothing in its own history to explain it.
    expect(result.returnedToPool).toStrictEqual([])
    expect(await pool.credential(agentCredentialId)).toMatchObject({ state: 'cooling_off' })
  }, 60_000)

  it('retries a credential the provider gave no return time for (FR-078)', async () => {
    // The population that would otherwise cool off for ever. `updated_at` is the clock — see the
    // module note for why, and why inventing a `cooling_off_until` would be the worse option.
    const agentCredentialId = await pool.seedCredential({
      label: 'unstated',
      credentialGroupId: groupId,
      state: 'cooling_off',
      coolingOffUntil: null,
    })
    // An hour before the pinned sweep clock, not before the wall clock: the row's `updated_at` is
    // when the credential entered `cooling_off`, and the sweep judges it against its own `now`.
    await pool.execute(
      `update agent_credentials set updated_at = '${ago(60 * 60_000).toISOString()}' where id = '${agentCredentialId}'`,
    )

    const result = await sweep(15 * 60_000)

    expect(result.returnedToPool).toMatchObject([
      { agentCredentialId, returnedBecause: 'unstated', returnedTo: 'available' },
    ])
    expect(await pool.credential(agentCredentialId)).toMatchObject({ state: 'available' })
  }, 60_000)

  it('waits out the configured interval before retrying one with no stated time', async () => {
    const agentCredentialId = await pool.seedCredential({
      label: 'unstated-fresh',
      credentialGroupId: groupId,
      state: 'cooling_off',
      coolingOffUntil: null,
    })
    // Ten minutes before the sweep's clock, against an hour-long interval.
    await pool.execute(
      `update agent_credentials set updated_at = '${ago(10 * 60_000).toISOString()}' where id = '${agentCredentialId}'`,
    )

    const result = await sweep(60 * 60_000)

    expect(result.returnedToPool).toStrictEqual([])
    expect(await pool.credential(agentCredentialId)).toMatchObject({ state: 'cooling_off' })
  }, 60_000)

  it('gives a seat back to the run that was waiting the limit out, not to the pool (FR-077)', async () => {
    // The bug this sweep could most easily introduce. That credential is still the run's — FR-023
    // forbids substituting another — so `available` would put one agent identity in front of a
    // second workflow while the first was still authenticated as it.
    const agentCredentialId = await pool.seedCredential({
      label: 'still-waiting',
      credentialGroupId: groupId,
      state: 'cooling_off',
      heldBy: 'workflow',
      coolingOffUntil: ago(60_000),
    })

    const result = await sweep()

    expect(result.returnedToPool).toMatchObject([{ agentCredentialId, returnedTo: 'held' }])
    expect(await pool.credential(agentCredentialId)).toMatchObject({
      state: 'held',
      heldBy: 'workflow',
    })
  }, 60_000)

  it('never returns an unhealthy credential, whatever the clock says (SC-010)', async () => {
    const agentCredentialId = await pool.seedCredential({
      label: 'broken',
      credentialGroupId: groupId,
      state: 'unhealthy',
      coolingOffUntil: ago(600_000),
    })

    const result = await sweep()

    // A broken login is not a limit, and no amount of waiting repairs it. Returning it on a timer
    // would hand it to the next workflow that asked.
    expect(result.returnedToPool).toStrictEqual([])
    expect(await pool.credential(agentCredentialId)).toMatchObject({ state: 'unhealthy' })
  }, 60_000)

  it('records the return as a credential state change (FR-058)', async () => {
    const agentCredentialId = await pool.seedCredential({
      label: 'audited',
      credentialGroupId: groupId,
      state: 'cooling_off',
      coolingOffUntil: ago(60_000),
    })

    await sweep()

    expect(await pool.auditFor(agentCredentialId)).toMatchObject([
      {
        action: 'state_changed',
        actorUserId: null,
        detail: { from: 'cooling_off', to: 'available' },
      },
    ])
  }, 60_000)

  it('drains the queue, so a returned seat reaches a waiting run in the same pass (FR-076)', async () => {
    // "Returns to selection automatically" is this line. Without it the credential would be
    // available and the run waiting for it would sit until the next tick — SC-005 gives it 30
    // seconds, and a tick is not a guarantee of that.
    await pool.seedCredential({
      label: 'drains',
      credentialGroupId: groupId,
      state: 'cooling_off',
      coolingOffUntil: ago(60_000),
    })
    let drained = 0

    const result = await reconcile({
      db: pool.db(),
      compute: createFakeComputeProvisioner(),
      now: () => NOW,
      queueDrain: {
        drain: () => {
          drained += 1
          return Promise.resolve()
        },
      },
    })

    expect(result.returnedToPool).toHaveLength(1)
    expect(drained).toBe(1)
  }, 60_000)

  it('is idempotent across passes', async () => {
    const agentCredentialId = await pool.seedCredential({
      label: 'twice',
      credentialGroupId: groupId,
      state: 'cooling_off',
      coolingOffUntil: ago(60_000),
    })

    await sweep()
    const second = await sweep()

    // The sweep runs on a timer. A second return would append a second `state_changed` entry for a
    // transition that only happened once.
    expect(second.returnedToPool).toStrictEqual([])
    expect(await pool.auditFor(agentCredentialId)).toHaveLength(1)
  }, 60_000)
})
