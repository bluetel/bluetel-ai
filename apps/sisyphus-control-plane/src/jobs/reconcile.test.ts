import { computeLeases, sessionSnapshots, workflowEvents } from '@bluetel-ai/sisyphus-api/db'
import { createFakeWorkflowNotifier } from '@bluetel-ai/sisyphus-notify'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createFakeComputeProvisioner } from '../aws'
import { liveCredentialFor, mintScopedCredential } from '../credentials'

import { validationInstanceTag } from './instance-tag'
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
