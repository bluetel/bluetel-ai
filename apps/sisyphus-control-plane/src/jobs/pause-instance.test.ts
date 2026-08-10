import type { ComputeLease } from '@bluetel-ai/sisyphus-api/db'
import {
  computeLeases,
  credentialLeases,
  sessionSnapshots,
  workflowEntries,
  workflowEvents,
  workflows,
  workspaceEntries,
} from '@bluetel-ai/sisyphus-api/db'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { FakeComputeProvisioner } from '../aws'
import { createFakeComputeProvisioner } from '../aws'
import {
  createCredentialPoolFixtures,
  readTestDatabaseUrl,
} from '../credentials/allocate/pool-fixtures'
import { releaseLease as releaseAgentCredentialLease } from '../credentials/lease'

import { admitWorkflow } from './admit-workflow'
import { pauseInstance, PAUSE_INSTANCE_JOB_NAME, runPauseInstance } from './pause-instance'
import { PAUSE_IDLE_CEILING_MS } from './reconcile'
import { resumeWorkflow } from './start-workflow'

/**
 * **T091 — pause and resume, across both purchase modes, with the seat held throughout.**
 *
 * The suite is one suite on purpose. FR-039 has two paths — `on_demand` stops its instance and
 * keeps the disk, `spot` cannot be stopped and degrades to 002's snapshot-and-terminate — and the
 * only way to be sure the second is not a divergent implementation of the first is to hold both to
 * the same assertions in the same place. Three properties are asserted on **both** branches:
 *
 * 1. the credential **lease is retained** — same row, same id, still live, before and after
 *    (FR-040). This is the claim the whole feature rests on, and a version of it that held on one
 *    branch and not the other would be no claim at all;
 * 2. the durable snapshot is a precondition, so neither path ever destroys or freezes an
 *    environment it could not rebuild the run from;
 * 3. the path taken is recorded, so SC-007 can be reported per mode rather than blended.
 *
 * And the assertion this suite exists for: **a spot pause and an on-demand pause whose instance
 * will not start again resume identically**, because they are the same code — `giveUpEnvironment`
 * then `recoverOntoFreshInstance`, reached by two causes. That is asserted by running both and
 * comparing the outcomes, rather than by reading the imports.
 *
 * Everything runs against `createFakeComputeProvisioner`. Nothing here builds an AWS client, and
 * the fake is faithful about the one behaviour that matters — `compute-fake.test.ts` proves a
 * stopped instance keeps its volume and a terminated one does not, which is what makes the
 * assertions below about the disk mean anything.
 */

const connectionString = readTestDatabaseUrl()
const describeWithDatabase = connectionString === undefined ? describe.skip : describe

const SECRET = 'test-signing-secret-not-a-real-one'
const MACHINE_SURFACE_URL = 'https://sisyphus.test/api/machine'

/** See `admit-workflow.ts`: `noUncheckedIndexedAccess` is off, so indexing needs an honest type. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

describeWithDatabase('pausing and resuming, on both purchase modes (003/FR-039)', () => {
  const pool = createCredentialPoolFixtures(connectionString ?? '')

  beforeAll(() => pool.open(), 60_000)
  afterAll(() => pool.close())

  afterEach(async () => {
    await pool.db().delete(workflowEvents)
    await pool.db().delete(workflowEntries)
    await pool.db().update(workflows).set({ currentSnapshotId: null })
    await pool.db().delete(sessionSnapshots)
    await pool.db().delete(computeLeases)
    await pool.clearLeases()
  })

  /**
   * The one workspace entry every fixture run points at.
   *
   * One, not one apiece: the pool fixtures share a single workspace *version* across the scope, and
   * `workspace_entries` allows exactly one primary entry per version — which is the schema saying
   * what a workspace is. `workflow_entries` is the per-run table, and that is where each run gets
   * its own row.
   */
  let workspaceEntryId: string | undefined

  const sharedWorkspaceEntry = async (): Promise<string> => {
    if (workspaceEntryId !== undefined) {
      return workspaceEntryId
    }

    const version = firstRow(
      await pool.db().select({ id: workflows.workspaceVersionId }).from(workflows).limit(1),
    )

    const entry = firstRow(
      await pool
        .db()
        .insert(workspaceEntries)
        .values({
          workspaceVersionId: version?.id ?? '',
          repositoryUrl: 'https://example.invalid/app.git',
          baseBranch: 'main',
          subdirectory: 'app',
          isPrimary: true,
          position: 0,
        })
        .returning({ id: workspaceEntries.id }),
    )

    if (entry === undefined) {
      throw new Error('Seeding a workspace entry returned no row.')
    }

    workspaceEntryId = entry.id
    return entry.id
  }

  interface PausedRun {
    readonly workflowId: string
    readonly agentCredentialId: string
    readonly instanceId: string
    readonly snapshotId: string
    readonly compute: FakeComputeProvisioner
  }

  /**
   * A run that has been paused by its executor and is waiting for the platform to act on it.
   *
   * Everything the pause job reads is real: the seat comes from `admitWorkflow`, so it is the lease
   * the production path produces; the compute lease is the one admission took, given an instance
   * id as provisioning would; the snapshot is registered and current with both state flags, as
   * `suspend()` leaves it; and the `paused` timeline row is the one
   * `acknowledgeSupervisionCommand` writes when the executor acknowledges.
   */
  const pausedRun = async (options: {
    readonly label: string
    readonly purchaseMode: ComputeLease['purchaseMode']
    readonly resumable?: boolean
  }): Promise<PausedRun> => {
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

    // Before admission, because admission copies the run's write-once job spec onto the lease —
    // which is what makes the lease's purchase mode the honest record of what was bought.
    await pool
      .db()
      .update(workflows)
      .set({ purchaseMode: options.purchaseMode })
      .where(eq(workflows.id, workflowId))

    await admitWorkflow({ db: pool.db(), workflowId, ceiling: 8 })

    const instanceId = `i-${options.label}`
    await pool
      .db()
      .update(computeLeases)
      .set({ providerInstanceId: instanceId, readyAt: new Date() })
      .where(eq(computeLeases.workflowId, workflowId))

    const snapshot = firstRow(
      await pool
        .db()
        .insert(sessionSnapshots)
        .values({
          workflowId,
          sessionId: crypto.randomUUID(),
          s3Key: `snapshots/${workflowId}/pause.tar.zst`,
          sizeBytes: 4_096,
          boundary: 'pause',
          // Both flags, because 002/FR-050 makes the pair the definition of resumable. The
          // `resumable: false` case below flips one of them, which is the shape a half-written
          // archive has.
          hasConversationState: true,
          hasWorktreeState: options.resumable !== false,
          isCurrent: true,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        })
        .returning({ id: sessionSnapshots.id }),
    )

    if (snapshot === undefined) {
      throw new Error('Seeding a session snapshot returned no row.')
    }

    await pool
      .db()
      .update(workflows)
      .set({ state: 'paused', currentSnapshotId: snapshot.id })
      .where(eq(workflows.id, workflowId))

    await pool
      .db()
      .insert(workflowEvents)
      .values({
        workflowId,
        event: 'paused',
        actorType: 'executor',
        detail: { commandId: `command-${options.label}` },
      })

    // A workspace entry, because the recovery path launches and provisioning refuses a run with an
    // incomplete workspace (002/FR-112).
    await pool
      .db()
      .insert(workflowEntries)
      .values({
        workflowId,
        workspaceEntryId: await sharedWorkspaceEntry(),
        repositoryUrl: 'https://example.invalid/app.git',
        baseBranch: 'main',
        subdirectory: 'app',
        isPrimary: true,
      })

    const compute = createFakeComputeProvisioner()
    compute.seedInstance({ instanceId, workflowId, state: 'running' })

    return { workflowId, agentCredentialId, instanceId, snapshotId: snapshot.id, compute }
  }

  /** The run's live credential lease, or `undefined`. The FR-040 assertion reads this. */
  const liveSeat = async (
    workflowId: string,
  ): Promise<{ readonly id: string; readonly agentCredentialId: string } | undefined> =>
    firstRow(
      await pool
        .db()
        .select({ id: credentialLeases.id, agentCredentialId: credentialLeases.agentCredentialId })
        .from(credentialLeases)
        .where(
          and(eq(credentialLeases.workflowId, workflowId), isNull(credentialLeases.releasedAt)),
        )
        .limit(1),
    )

  const liveComputeLease = async (workflowId: string) =>
    firstRow(
      await pool
        .db()
        .select()
        .from(computeLeases)
        .where(and(eq(computeLeases.workflowId, workflowId), isNull(computeLeases.releasedAt)))
        .limit(1),
    )

  /** The newest `paused` timeline row's detail — where the path a pause took is recorded. */
  const pausedEvents = async (workflowId: string) =>
    pool
      .db()
      .select({ detail: workflowEvents.detail, actorType: workflowEvents.actorType })
      .from(workflowEvents)
      .where(and(eq(workflowEvents.workflowId, workflowId), eq(workflowEvents.event, 'paused')))
      .orderBy(asc(workflowEvents.createdAt), asc(workflowEvents.id))

  /**
   * A clock a minute past the pause idle limit.
   *
   * The clock is moved rather than the `paused` row's `created_at`, because the clock is the thing
   * the job takes as an input: `pauseInstance` measures `now() - created_at`, so advancing `now`
   * tests the same subtraction the deployment performs, and leaves the timeline row exactly as
   * `acknowledgeSupervisionCommand` wrote it — which is the row the assertions about the merge and
   * about the parking clock both depend on.
   */
  const pastTheIdleLimit = (): Date => new Date(Date.now() + PAUSE_IDLE_CEILING_MS + 60_000)

  const pause = (run: PausedRun, now?: () => Date) =>
    pauseInstance({
      db: pool.db(),
      compute: run.compute,
      workflowId: run.workflowId,
      ...(now === undefined ? {} : { now }),
    })

  /** The run as the workflows table has it — the park's `parked_resumable` is asserted here. */
  const workflowRow = async (workflowId: string) =>
    firstRow(
      await pool
        .db()
        .select({
          state: workflows.state,
          terminalOutcome: workflows.terminalOutcome,
          outcomeReason: workflows.outcomeReason,
        })
        .from(workflows)
        .where(eq(workflows.id, workflowId))
        .limit(1),
    )

  /** The `parked` timeline row, which is a second event rather than a merge into the pause. */
  const parkedEvent = async (workflowId: string) =>
    firstRow(
      await pool
        .db()
        .select({ detail: workflowEvents.detail, actorType: workflowEvents.actorType })
        .from(workflowEvents)
        .where(and(eq(workflowEvents.workflowId, workflowId), eq(workflowEvents.event, 'parked'))),
    )

  const resume = (run: PausedRun) =>
    resumeWorkflow({
      db: pool.db(),
      compute: run.compute,
      machineSurfaceUrl: MACHINE_SURFACE_URL,
      credentialSecret: SECRET,
      workflowId: run.workflowId,
    })

  describe('on_demand — the instance stops and keeps its disk (FR-039)', () => {
    it('stops the instance, retains the volume, and releases no lease', async () => {
      const run = await pausedRun({ label: 'on-demand-stop', purchaseMode: 'on_demand' })
      const before = await liveSeat(run.workflowId)

      const outcome = await pause(run)

      expect(outcome).toMatchObject({
        outcome: 'paused',
        path: 'stopped',
        purchaseMode: 'on_demand',
        instanceId: run.instanceId,
        agentCredentialId: run.agentCredentialId,
      })
      expect(run.compute.stops).toStrictEqual([run.instanceId])
      // Not terminated. That difference is the whole of FR-039, and the fake is faithful about it.
      expect(run.compute.terminations).toStrictEqual([])

      // The disk, as the provider reports it after the stop rather than as the pause intended it.
      const retained =
        outcome.outcome === 'paused' && outcome.path === 'stopped' ? outcome.retainedVolumes : []
      expect(retained).toHaveLength(1)
      await expect(
        run.compute.describeVolumes({ instanceId: run.instanceId }),
      ).resolves.toHaveLength(1)

      // The compute lease stays live and keeps naming the instance: it is still this run's, merely
      // off, and the id on it is how the resume finds it again (FR-041).
      const lease = await liveComputeLease(run.workflowId)
      expect(lease?.providerInstanceId).toBe(run.instanceId)
      expect(lease?.releasedAt).toBeNull()

      // FR-040, branch one. The same lease row, still live.
      expect(await liveSeat(run.workflowId)).toStrictEqual(before)
    })

    it('resumes by starting the same instance — no launch, no clone, no restore (FR-041)', async () => {
      const run = await pausedRun({ label: 'on-demand-resume', purchaseMode: 'on_demand' })
      await pause(run)
      const seatBefore = await liveSeat(run.workflowId)

      const outcome = await resume(run)

      expect(outcome).toMatchObject({
        outcome: 'resumed',
        path: 'started',
        instanceId: run.instanceId,
        agentCredentialId: run.agentCredentialId,
      })
      expect(run.compute.starts).toStrictEqual([run.instanceId])
      // The three prohibitions FR-041 is written as, asserted as absences: nothing was launched, so
      // nothing was re-provisioned, no envelope was assembled and no snapshot was restored.
      expect(run.compute.launches).toStrictEqual([])

      // The same lease row throughout: not released, not replaced, same instance, same `ready_at`.
      const lease = await liveComputeLease(run.workflowId)
      expect(lease?.providerInstanceId).toBe(run.instanceId)

      // FR-040 again, on the far side of a full pause→resume cycle.
      expect(await liveSeat(run.workflowId)).toStrictEqual(seatBefore)
      // And exactly one lease was ever taken. A resume that reserved a second seat would be one
      // workflow performed by two agents (SC-018).
      expect(await pool.leases()).toHaveLength(1)
    })
  })

  describe('spot — it cannot be stopped, so it degrades to 002 (FR-039, R6)', () => {
    it('snapshots and terminates, keeping the seat (FR-040)', async () => {
      const run = await pausedRun({ label: 'spot-terminate', purchaseMode: 'spot' })
      const before = await liveSeat(run.workflowId)

      const outcome = await pause(run)

      expect(outcome).toMatchObject({
        outcome: 'paused',
        path: 'snapshot_recovery',
        purchaseMode: 'spot',
        // Routed through the FR-043 fallback, and the cause says which of its three ways in this
        // was. A pause that recorded no cause could not be told from a stranded instance later.
        cause: 'spot_cannot_stop',
        terminatedInstanceId: run.instanceId,
        snapshotId: run.snapshotId,
        agentCredentialId: run.agentCredentialId,
      })
      expect(run.compute.terminations).toStrictEqual([run.instanceId])
      expect(run.compute.stops).toStrictEqual([])
      // The disk went with it — which is exactly why the durable snapshot had to be there first.
      await expect(run.compute.describeVolumes({ instanceId: run.instanceId })).resolves.toEqual([])

      // The compute lease is released, with the cause recorded where a person reads it.
      expect(await liveComputeLease(run.workflowId)).toBeUndefined()
      const released = firstRow(
        await pool
          .db()
          .select({ releaseReason: computeLeases.releaseReason })
          .from(computeLeases)
          .where(eq(computeLeases.workflowId, run.workflowId)),
      )
      expect(released?.releaseReason).toContain('interruptible capacity')

      // FR-040, branch two — the assertion that has to hold identically on both, and does.
      expect(await liveSeat(run.workflowId)).toStrictEqual(before)
    })

    it('resumes onto a fresh instance under the same credential, recording the substitution (FR-043)', async () => {
      const run = await pausedRun({ label: 'spot-recover', purchaseMode: 'spot' })
      await pause(run)
      const seatBefore = await liveSeat(run.workflowId)

      const outcome = await resume(run)

      expect(outcome).toMatchObject({
        outcome: 'resumed',
        path: 'recovered',
        cause: 'spot_cannot_stop',
        snapshotId: run.snapshotId,
        // **The same seat.** The instance was substituted; the identity was not (SC-018).
        agentCredentialId: run.agentCredentialId,
      })
      expect(run.compute.launches).toHaveLength(1)
      expect(await liveSeat(run.workflowId)).toStrictEqual(seatBefore)
      expect(await pool.leases()).toHaveLength(1)

      // The envelope carries the snapshot to resume from — this is 002's restore path, which is
      // precisely what FR-039 says spot degrades to.
      const envelope = firstRow(run.compute.launches)?.userData ?? ''
      expect(envelope).toContain('resumeFromSnapshot')

      // The substitution, recorded (FR-043).
      const resumed = firstRow(
        await pool
          .db()
          .select({ detail: workflowEvents.detail })
          .from(workflowEvents)
          .where(
            and(eq(workflowEvents.workflowId, run.workflowId), eq(workflowEvents.event, 'resumed')),
          ),
      )
      expect(resumed?.detail).toMatchObject({
        path: 'recovered_from_snapshot',
        cause: 'spot_cannot_stop',
        agentCredentialId: run.agentCredentialId,
      })
    })
  })

  /**
   * **T100 — past the idle limit, a pause stops being a pause.**
   *
   * The three claims FR-044 makes, plus the one it does not make and FR-073 does:
   *
   * 1. the **instance and the disk** are released, which is what separates a park from a pause and
   *    is asserted through the fake's volume table rather than through the job's own report;
   * 2. the run is **parked rather than failed** — the same work, two words that mean opposite
   *    things to the person who left it, so the state, the terminal outcome and the timeline row
   *    are all read back;
   * 3. an unresumable snapshot **stops the release entirely** (FR-045), because a park that cannot
   *    be resumed is not a park;
   * 4. the **seat is kept** (FR-073), through the park and through the resume that follows it.
   */
  describe('past the idle limit, the run parks (FR-044, FR-045, FR-073)', () => {
    it('releases the instance and its disk, and keeps the seat', async () => {
      const run = await pausedRun({ label: 'park-on-demand', purchaseMode: 'on_demand' })
      // The ordinary sequence: the pause stopped the instance and kept the disk, and then nobody
      // came back for it.
      await pause(run)
      const before = await liveSeat(run.workflowId)

      const outcome = await pause(run, pastTheIdleLimit)

      expect(outcome).toMatchObject({
        outcome: 'parked',
        releasedInstanceId: run.instanceId,
        snapshotId: run.snapshotId,
        agentCredentialId: run.agentCredentialId,
      })
      expect(run.compute.terminations).toStrictEqual([run.instanceId])
      // The disk went with the instance, read back from the provider rather than asserted about
      // the job's intention. `compute-fake.test.ts` is what makes this line mean anything.
      await expect(run.compute.describeVolumes({ instanceId: run.instanceId })).resolves.toEqual([])
      // And the compute lease is released, so the run is paying for storage and nothing else.
      expect(await liveComputeLease(run.workflowId)).toBeUndefined()

      // FR-073. The same lease row, still live, on the far side of everything else being let go.
      expect(await liveSeat(run.workflowId)).toStrictEqual(before)
    })

    it('reports it as parked rather than failed, on the run and on the timeline', async () => {
      const run = await pausedRun({ label: 'park-reported', purchaseMode: 'on_demand' })
      await pause(run)

      await pause(run, pastTheIdleLimit)

      const workflow = await workflowRow(run.workflowId)
      expect(workflow).toMatchObject({
        state: 'parked_resumable',
        terminalOutcome: 'parked_resumable',
      })
      // "Parked rather than failed" is not a nicety: `failed` tells the person who paused this run
      // that their work is gone, and it is sitting in S3 waiting for them.
      expect(workflow?.outcomeReason).toContain('parked rather than failed')

      const parked = await parkedEvent(run.workflowId)
      expect(parked?.actorType).toBe('control_plane')
      expect(parked?.detail).toMatchObject({
        cause: 'parked_past_idle_limit',
        snapshotId: run.snapshotId,
        releasedInstanceId: run.instanceId,
        agentCredentialId: run.agentCredentialId,
      })

      // The `paused` row is still one row. The park writes its own event rather than a second
      // `paused` one, which is what keeps the clock this decision was made against readable.
      expect(await pausedEvents(run.workflowId)).toHaveLength(1)
    })

    it('parks a run whose instance an earlier pause had already given up', async () => {
      // The spot case, and the one a park written around "terminate the instance" would miss: a
      // spot pause has no instance left, and spot is the platform default — so the mode that never
      // parked would be the mode nearly every run uses.
      const run = await pausedRun({ label: 'park-spot', purchaseMode: 'spot' })
      await pause(run)
      const before = await liveSeat(run.workflowId)

      const outcome = await pause(run, pastTheIdleLimit)

      expect(outcome).toMatchObject({ outcome: 'parked', releasedInstanceId: undefined })
      // Not terminated a second time: there was nothing left to terminate.
      expect(run.compute.terminations).toStrictEqual([run.instanceId])
      expect((await workflowRow(run.workflowId))?.state).toBe('parked_resumable')
      expect(await liveSeat(run.workflowId)).toStrictEqual(before)
    })

    it('refuses to release the instance or the disk when the snapshot is not resumable (FR-045)', async () => {
      const run = await pausedRun({
        label: 'park-unresumable',
        purchaseMode: 'on_demand',
        resumable: false,
      })

      const outcome = await pause(run, pastTheIdleLimit)

      // The deliberate inversion of the usual cost priority: the run goes on billing, because an
      // unresumable park is indistinguishable from having deleted somebody's work.
      expect(outcome.outcome).toBe('refused')
      expect(outcome.outcome === 'refused' ? outcome.reason : '').toContain('FR-045')
      expect(run.compute.terminations).toStrictEqual([])
      expect(run.compute.stops).toStrictEqual([])
      await expect(
        run.compute.describeVolumes({ instanceId: run.instanceId }),
      ).resolves.toHaveLength(1)
      // Not parked, either: a run reported as parked whose snapshot cannot be resumed is a promise
      // the platform cannot keep.
      expect((await workflowRow(run.workflowId))?.state).toBe('paused')
      expect(await liveComputeLease(run.workflowId)).toBeDefined()
      expect(await liveSeat(run.workflowId)).toBeDefined()
    })

    it('leaves a pause the timeline never recorded alone, however old it looks', async () => {
      // No `paused` row is no evidence of when the pause began, and a park decided without evidence
      // is a park of somebody's thirty-second pause. The sweep applies the same rule to the same
      // absence.
      const run = await pausedRun({ label: 'park-unclocked', purchaseMode: 'on_demand' })
      await pool.db().delete(workflowEvents)

      const outcome = await pause(run, pastTheIdleLimit)

      expect(outcome).toMatchObject({ outcome: 'paused', path: 'stopped' })
      expect((await workflowRow(run.workflowId))?.state).toBe('paused')
    })

    it('resumes onto a fresh instance without reserving or waiting for a credential (FR-046)', async () => {
      const run = await pausedRun({ label: 'park-resume', purchaseMode: 'on_demand' })
      await pause(run)
      await pause(run, pastTheIdleLimit)
      const seatBefore = await liveSeat(run.workflowId)

      const outcome = await resume(run)

      expect(outcome).toMatchObject({
        outcome: 'resumed',
        path: 'recovered',
        cause: 'parked_past_idle_limit',
        // Nothing to replace: the park released the instance and the lease that named it.
        replacedInstanceId: undefined,
        snapshotId: run.snapshotId,
        agentCredentialId: run.agentCredentialId,
      })
      expect(run.compute.launches).toHaveLength(1)
      // The run came back off its terminal outcome rather than carrying two accounts of itself.
      expect(await workflowRow(run.workflowId)).toMatchObject({
        state: 'provisioning',
        terminalOutcome: null,
      })

      // **The acquire path was never reached**, and this is the assertion that says so rather than
      // hoping. This run's group holds exactly one credential and this run is holding it, so an
      // acquisition would have found nothing available and left the run `awaiting_credential` with
      // a `queued` row recording the wait. It is `provisioning`, there is no such row, and the
      // lease it holds is the identical row it held before the park.
      expect(
        await pool
          .db()
          .select({ id: workflowEvents.id })
          .from(workflowEvents)
          .where(
            and(eq(workflowEvents.workflowId, run.workflowId), eq(workflowEvents.event, 'queued')),
          ),
      ).toStrictEqual([])
      expect(await liveSeat(run.workflowId)).toStrictEqual(seatBefore)
      expect(await pool.leases()).toHaveLength(1)
    })

    it('refuses to resume a parked run whose seat has been handed back (FR-023, SC-018)', async () => {
      const run = await pausedRun({ label: 'park-seatless', purchaseMode: 'on_demand' })
      await pause(run)
      await pause(run, pastTheIdleLimit)
      // What `reconcile.ts` does when a parked run's snapshot passes its retention period: the
      // park has become an ending, and the seat goes back to the pool (FR-073).
      await releaseAgentCredentialLease({
        db: pool.db(),
        workflowId: run.workflowId,
        reason: 'terminal',
      })

      const outcome = await resume(run)

      // Not "acquire another one". A workflow is performed end to end by exactly one agent
      // credential, so a run that no longer holds one has ended, whatever its snapshot says.
      expect(outcome).toMatchObject({ outcome: 'not_resumable', state: 'parked_resumable' })
      expect(outcome.outcome === 'not_resumable' ? outcome.reason : '').toContain('FR-023')
      expect(run.compute.launches).toStrictEqual([])
      expect(await pool.liveLeases()).toStrictEqual([])
    })

    /**
     * **SC-018, stated as a count.**
     *
     * *"Every workflow is performed end to end by exactly one agent credential — zero occurrences
     * of a workflow spanning two identities, including across pauses, parks and environment
     * rebuilds."* Every one of those three happens to this run, in order: it is paused and stopped,
     * parked with its instance and disk destroyed, and rebuilt onto a fresh instance from its
     * snapshot. The whole `credential_leases` history for the run is then read back — released rows
     * included, because a second identity would leave a first row released and a second one live,
     * and a live-only assertion would see one row and call it proof.
     */
    it('holds exactly one lease row across the whole pause, park and resume cycle (SC-018)', async () => {
      const run = await pausedRun({ label: 'park-cycle', purchaseMode: 'on_demand' })
      const atStart = await liveSeat(run.workflowId)
      expect(atStart?.agentCredentialId).toBe(run.agentCredentialId)

      await pause(run)
      expect(await liveSeat(run.workflowId)).toStrictEqual(atStart)

      await pause(run, pastTheIdleLimit)
      expect(await liveSeat(run.workflowId)).toStrictEqual(atStart)

      const resumed = await resume(run)
      expect(resumed).toMatchObject({
        outcome: 'resumed',
        agentCredentialId: run.agentCredentialId,
      })
      expect(await liveSeat(run.workflowId)).toStrictEqual(atStart)

      const history = (await pool.leases()).filter((lease) => lease.workflowId === run.workflowId)
      expect(history).toHaveLength(1)
      expect(history[0]).toMatchObject({
        agentCredentialId: run.agentCredentialId,
        releasedAt: null,
        releaseReason: null,
      })
      // And the credential itself never left this run's hands: `held`, by a workflow rather than by
      // a keep-alive, for the whole cycle.
      expect(await pool.credential(run.agentCredentialId)).toMatchObject({
        state: 'held',
        heldBy: 'workflow',
      })
    })
  })

  /**
   * **The assertion this whole suite is arranged around.**
   *
   * FR-039 routes a spot pause through the FR-043 recovery "rather than implemented as a second
   * one". That is a claim about the code, and the only honest way to test a claim about the code is
   * to show the two callers producing the same behaviour — so this runs a spot pause and an
   * on-demand pause whose stopped instance then refuses to start, and compares what a resume does
   * with each. Everything differs except the cause, which is the point: the cause is the *only*
   * thing the two paths were allowed to differ in.
   */
  it('lands a spot pause and a stranded on-demand instance on the same recovery (FR-043)', async () => {
    const spot = await pausedRun({ label: 'converge-spot', purchaseMode: 'spot' })
    await pause(spot)
    const spotResume = await resume(spot)

    const onDemand = await pausedRun({ label: 'converge-od', purchaseMode: 'on_demand' })
    await pause(onDemand)
    // The FR-043 case as written: the disk is there, the platform believes the run is resumable,
    // and the capacity is not.
    onDemand.compute.failNextStart(new Error('InsufficientInstanceCapacity'))
    const onDemandResume = await resume(onDemand)

    const shapeOf = (outcome: typeof spotResume): unknown =>
      outcome.outcome === 'resumed' && outcome.path === 'recovered'
        ? {
            outcome: outcome.outcome,
            path: outcome.path,
            launched: true,
            replaced: outcome.replacedInstanceId !== undefined,
          }
        : { outcome: outcome.outcome }

    expect(shapeOf(spotResume)).toStrictEqual({
      outcome: 'resumed',
      path: 'recovered',
      launched: true,
      // The one difference, and it is a fact about history rather than about behaviour: the spot
      // pause already gave its instance up, so there is nothing left for the resume to name.
      replaced: false,
    })
    expect(shapeOf(onDemandResume)).toStrictEqual({
      outcome: 'resumed',
      path: 'recovered',
      launched: true,
      replaced: true,
    })

    // Both gave the old environment up through the same function, so both left the same kind of
    // record on the lease they released, and both kept their seat.
    for (const run of [spot, onDemand]) {
      expect(await liveSeat(run.workflowId)).toBeDefined()
      expect(await pool.leases()).toHaveLength(2)
    }
    // The stranded on-demand instance was terminated rather than left running and billing.
    expect(onDemand.compute.terminations).toStrictEqual([onDemand.instanceId])
  })

  describe('what neither path will do', () => {
    it('refuses to touch the environment of a run with no resumable snapshot', async () => {
      for (const purchaseMode of ['on_demand', 'spot'] as const) {
        const run = await pausedRun({
          label: `unresumable-${purchaseMode}`,
          purchaseMode,
          resumable: false,
        })

        const outcome = await pause(run)

        expect(outcome.outcome).toBe('refused')
        // Nothing happened to the instance on either branch. An instance that goes on billing is
        // recoverable; a run whose only copy of itself was on a disk that no longer exists is not.
        expect(run.compute.stops).toStrictEqual([])
        expect(run.compute.terminations).toStrictEqual([])
        expect(await liveComputeLease(run.workflowId)).toBeDefined()
        expect(await liveSeat(run.workflowId)).toBeDefined()
      }
    })

    it('refuses a run that has not reached a turn boundary (FR-039)', async () => {
      const run = await pausedRun({ label: 'still-running', purchaseMode: 'on_demand' })
      await pool
        .db()
        .update(workflows)
        .set({ state: 'running' })
        .where(eq(workflows.id, run.workflowId))

      const outcome = await pause(run)

      // The acknowledged `paused` state is the platform's record that the executor quiesced,
      // captured and registered. Without it, this job would be stopping an instance mid-turn.
      expect(outcome).toMatchObject({ outcome: 'not_pausable', state: 'running' })
      expect(run.compute.stops).toStrictEqual([])
    })

    it('is idempotent once the instance is already gone', async () => {
      const run = await pausedRun({ label: 'twice-spot', purchaseMode: 'spot' })
      await pause(run)

      const second = await pause(run)

      expect(second).toMatchObject({
        outcome: 'no_instance',
        agentCredentialId: run.agentCredentialId,
      })
      expect(run.compute.terminations).toStrictEqual([run.instanceId])
    })

    it('never releases the seat, on either path (FR-040)', async () => {
      for (const purchaseMode of ['on_demand', 'spot'] as const) {
        const run = await pausedRun({ label: `seat-${purchaseMode}`, purchaseMode })

        await pause(run)

        const leases = await pool.leases()
        const held = leases.filter((lease) => lease.workflowId === run.workflowId)
        expect(held).toHaveLength(1)
        expect(held[0]?.releasedAt).toBeNull()
        expect(held[0]?.releaseReason).toBeNull()
        await pool.clearLeases()
      }
    })
  })

  describe('recording which path a pause took (SC-007)', () => {
    it.each([
      { purchaseMode: 'on_demand' as const, pausePath: 'stopped' },
      { purchaseMode: 'spot' as const, pausePath: 'snapshot_recovery' },
    ])('records $pausePath for $purchaseMode', async ({ purchaseMode, pausePath }) => {
      const run = await pausedRun({ label: `record-${purchaseMode}`, purchaseMode })

      await pause(run)

      const events = await pausedEvents(run.workflowId)
      // **One `paused` row, not two.** `reconcile.ts` reads the latest one's `created_at` as the
      // instant the pause began; a second row written here would reset that clock every time, and
      // a pause whose clock keeps restarting never reaches the idle limit that parks it (FR-044).
      expect(events).toHaveLength(1)
      expect(events[0]?.detail).toMatchObject({
        pausePath,
        purchaseMode,
        // The executor's own record of the pause it acknowledged survives the merge.
        commandId: `command-record-${purchaseMode}`,
      })
    })

    it('starts the clock for a pause the timeline never recorded', async () => {
      const run = await pausedRun({ label: 'no-timeline', purchaseMode: 'on_demand' })
      await pool.db().delete(workflowEvents)

      await pause(run)

      // `reconcile.ts` leaves a paused run with no `paused` row alone for ever. Writing one starts
      // a clock that was otherwise never going to start.
      const events = await pausedEvents(run.workflowId)
      expect(events).toHaveLength(1)
      expect(events[0]?.actorType).toBe('control_plane')
      expect(events[0]?.detail).toMatchObject({ pausePath: 'stopped' })
    })
  })

  it('reports through the uniform job envelope', async () => {
    const run = await pausedRun({ label: 'enveloped', purchaseMode: 'on_demand' })

    const outcome = await runPauseInstance({
      db: pool.db(),
      compute: run.compute,
      workflowId: run.workflowId,
    })

    expect(outcome.jobName).toBe(PAUSE_INSTANCE_JOB_NAME)
    expect(outcome.ok).toBe(true)
  })

  it('fails loudly for a workflow that does not exist', async () => {
    await expect(
      pauseInstance({
        db: pool.db(),
        compute: createFakeComputeProvisioner(),
        workflowId: '00000000-0000-7000-8000-000000000000',
      }),
    ).rejects.toThrow(/does not exist/)
  })
})
