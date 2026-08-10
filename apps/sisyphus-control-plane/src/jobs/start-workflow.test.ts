import type { SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'
import {
  bootstrapPhases,
  computeLeases,
  sessionSnapshots,
  workflowEntries,
  workflowEvents,
  workflows,
  workspaceEntries,
} from '@bluetel-ai/sisyphus-api/db'
import { eq } from 'drizzle-orm'
import { decodeJwt } from 'jose'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { ComputeProvisioner } from '../aws'
import { createFakeComputeProvisioner } from '../aws'
import { liveCredentialFor } from '../credentials'
import { createCredentialPoolFixtures } from '../credentials/allocate/pool-fixtures'

import { admitWorkflow } from './admit-workflow'
import type { WorkflowJobEnvelope } from './job-envelope'
import type { StartWorkflowOutcome } from './start-workflow'
import { resumeWorkflow, startWorkflow } from './start-workflow'
import { createWorkflowFixtures, readTestDatabaseUrl } from './workflow-fixtures'

/**
 * **Every test here runs against `createFakeComputeProvisioner`.** Nothing in this file, or
 * anything it imports, constructs an AWS client — the adapters in `src/aws` are handed one, and the
 * fake is the one handed here. That is the entire reason T054 exists, and it is what makes it
 * possible to test the code that launches EC2 instances without launching one.
 *
 * The assertions worth reading twice are the two about the envelope: that it carries the whole job
 * specification, and that the *only* credential in it is the short-lived scoped one.
 */

const connectionString = readTestDatabaseUrl()
const describeWithDatabase = connectionString === undefined ? describe.skip : describe

const SECRET = 'test-signing-secret-not-a-real-one'
const MACHINE_SURFACE_URL = 'https://sisyphus.test/api/machine'

/** See `admit-workflow.ts`: `noUncheckedIndexedAccess` is off, so indexing needs an honest type. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/**
 * Give a fixture workflow the workspace entries provisioning refuses to launch without.
 *
 * The fixture harness seeds a workspace *version* but no entries, because admission never looks at
 * them. Provisioning does, so this fills the gap without touching the shared harness.
 */
const seedEntry = async (
  db: SisyphusDatabase,
  workflowId: string,
  entry: {
    readonly subdirectory: string
    readonly repositoryUrl?: string
    readonly baseBranch?: string
    readonly isPrimary?: boolean
    readonly position?: number
  },
): Promise<string> => {
  const workflow = firstRow(
    await db
      .select({ workspaceVersionId: workflows.workspaceVersionId })
      .from(workflows)
      .where(eq(workflows.id, workflowId))
      .limit(1),
  )

  if (workflow === undefined) {
    throw new Error(`No workflow ${workflowId} to attach an entry to.`)
  }

  const repositoryUrl = entry.repositoryUrl ?? `https://example.invalid/${entry.subdirectory}.git`
  const baseBranch = entry.baseBranch ?? 'main'
  const isPrimary = entry.isPrimary ?? true

  const workspaceEntry = firstRow(
    await db
      .insert(workspaceEntries)
      .values({
        workspaceVersionId: workflow.workspaceVersionId,
        repositoryUrl,
        baseBranch,
        subdirectory: entry.subdirectory,
        isPrimary,
        position: entry.position ?? 0,
      })
      .returning({ id: workspaceEntries.id }),
  )

  if (workspaceEntry === undefined) {
    throw new Error('Seeding a workspace entry returned no row.')
  }

  const workflowEntry = firstRow(
    await db
      .insert(workflowEntries)
      .values({
        workflowId,
        workspaceEntryId: workspaceEntry.id,
        repositoryUrl,
        baseBranch,
        subdirectory: entry.subdirectory,
        isPrimary,
      })
      .returning({ id: workflowEntries.id }),
  )

  if (workflowEntry === undefined) {
    throw new Error('Seeding a workflow entry returned no row.')
  }

  return workflowEntry.id
}

describeWithDatabase('provisioning an admitted workflow', () => {
  const fixtures = createWorkflowFixtures(connectionString ?? '')

  beforeAll(() => fixtures.open(), 60_000)
  afterEach(() => fixtures.removeAll())
  afterAll(() => fixtures.close())

  /** A workflow admitted as far as `provisioning`, with a live lease and one workspace entry. */
  const admittedWorkflow = async (options: {
    readonly label: string
    readonly instanceType?: string
    readonly purchaseMode?: 'on_demand' | 'spot'
  }): Promise<{ readonly workflowId: string; readonly entryId: string }> => {
    const workflowId = await fixtures.seedWorkflow({
      label: options.label,
      state: 'provisioning',
      instanceType: options.instanceType,
      purchaseMode: options.purchaseMode,
    })
    const entryId = await seedEntry(fixtures.db(), workflowId, { subdirectory: 'app' })

    await fixtures
      .db()
      .insert(computeLeases)
      .values({
        workflowId,
        instanceType: options.instanceType ?? 'fixture.small',
        purchaseMode: options.purchaseMode ?? 'spot',
      })

    return { workflowId, entryId }
  }

  const start = (
    workflowId: string,
    compute: ComputeProvisioner = createFakeComputeProvisioner(),
  ) =>
    startWorkflow({
      db: fixtures.db(),
      compute,
      machineSurfaceUrl: MACHINE_SURFACE_URL,
      credentialSecret: SECRET,
      workflowId,
    })

  it('launches one instance and records it on the lease', async () => {
    const { workflowId } = await admittedWorkflow({ label: 'launch' })
    const compute = createFakeComputeProvisioner({ instanceIds: ['i-0abc'] })

    const outcome = await start(workflowId, compute)

    expect(outcome).toMatchObject({ outcome: 'started', instanceId: 'i-0abc' })
    expect(compute.launches).toHaveLength(1)

    const lease = firstRow(
      await fixtures
        .db()
        .select()
        .from(computeLeases)
        .where(eq(computeLeases.workflowId, workflowId)),
    )
    expect(lease?.providerInstanceId).toBe('i-0abc')
    expect(lease?.readyAt).not.toBeNull()
  })

  it('sizes and prices the instance from the job spec rather than from a default here', async () => {
    const { workflowId } = await admittedWorkflow({
      label: 'spec',
      instanceType: 'c7i.4xlarge',
      purchaseMode: 'on_demand',
    })
    const compute = createFakeComputeProvisioner()

    await start(workflowId, compute)

    // `on_demand` survives, which is the case a default would silently overwrite: spot is the
    // platform default, and a run that asked for reserved capacity getting interruptible capacity
    // is a correctness failure that only shows up as an unexplained interruption.
    expect(firstRow(compute.launches)).toMatchObject({
      instanceType: 'c7i.4xlarge',
      purchaseMode: 'on_demand',
      workflowId,
    })
  })

  it('carries every job parameter in the user-data envelope', async () => {
    const { workflowId, entryId } = await admittedWorkflow({ label: 'envelope' })
    const compute = createFakeComputeProvisioner()

    await start(workflowId, compute)

    const envelope = JSON.parse(firstRow(compute.launches)?.userData ?? '{}') as WorkflowJobEnvelope

    expect(envelope.mode).toBe('workflow')
    expect(envelope.workflowId).toBe(workflowId)
    expect(envelope.machineSurfaceUrl).toBe(MACHINE_SURFACE_URL)
    expect(envelope.workspace.root).toBe('/workspace')
    expect(envelope.workspace.entries).toStrictEqual([
      {
        entryId,
        repositoryUrl: 'https://example.invalid/app.git',
        baseBranch: 'main',
        subdirectory: 'app',
        isPrimary: true,
      },
    ])
    expect(envelope.job).toMatchObject({ model: 'claude-sonnet-5', workflowType: 'delegated' })
    expect(envelope.prompt.assembled).toContain('Fixture prompt envelope')
    expect(envelope.setupBundle.contentDigest).toBe(`sha256:${fixtures.suffix}`)
  })

  it('puts a short-lived, workflow-scoped credential in the envelope and no long-lived secret', async () => {
    const { workflowId } = await admittedWorkflow({ label: 'credential' })
    const compute = createFakeComputeProvisioner()

    await start(workflowId, compute)

    const userData = firstRow(compute.launches)?.userData ?? ''
    const envelope = JSON.parse(userData) as WorkflowJobEnvelope
    const claims = decodeJwt(envelope.scopedCredential)

    expect(claims.sub).toBe(`workflow:${workflowId}`)
    expect(claims.aud).toBe('sisyphus-machine-surface')

    // The signing secret is what would let the instance mint credentials for other runs. It is
    // never in the envelope — only what it signed is.
    expect(userData).not.toContain(SECRET)

    const stored = await liveCredentialFor(fixtures.db(), workflowId)
    expect(stored?.jti).toBe(claims.jti)
  })

  it('records the provisioning bootstrap phase, so the panel is never opaquely provisioning', async () => {
    const { workflowId } = await admittedWorkflow({ label: 'phase' })

    await start(workflowId)

    const phases = await fixtures
      .db()
      .select()
      .from(bootstrapPhases)
      .where(eq(bootstrapPhases.workflowId, workflowId))

    expect(phases).toHaveLength(1)
    expect(phases[0]).toMatchObject({ phase: 'provisioning', outcome: 'succeeded', sequence: 1 })
  })

  it('records the provisioned event with the cost basis', async () => {
    const { workflowId } = await admittedWorkflow({ label: 'event' })

    await start(workflowId)

    const events = await fixtures
      .db()
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.workflowId, workflowId))

    expect(events.map((event) => event.event)).toContain('provisioned')
  })

  describe('when the launch fails', () => {
    it('leaves the lease intact for the reconciler and rethrows for startFailures', async () => {
      const { workflowId } = await admittedWorkflow({ label: 'capacity' })
      const compute = createFakeComputeProvisioner()
      compute.failNextLaunch(new Error('InsufficientInstanceCapacity'))

      await expect(start(workflowId, compute)).rejects.toThrow(/InsufficientInstanceCapacity/)

      // The lease stands. Releasing it here would be the control plane deciding a capacity refusal
      // means the run is over, which is the reconciler's call to make, not this job's.
      const lease = firstRow(
        await fixtures
          .db()
          .select()
          .from(computeLeases)
          .where(eq(computeLeases.workflowId, workflowId)),
      )
      expect(lease?.releasedAt).toBeNull()
      expect(lease?.providerInstanceId).toBeNull()
    })

    it('revokes the credential it minted for an instance that never booted', async () => {
      const { workflowId } = await admittedWorkflow({ label: 'revoke-on-failure' })
      const compute = createFakeComputeProvisioner()
      compute.failNextLaunch(new Error('InsufficientInstanceCapacity'))

      await expect(start(workflowId, compute)).rejects.toThrow()

      expect(await liveCredentialFor(fixtures.db(), workflowId)).toBeUndefined()
    })

    it('records the failure against the named provisioning phase', async () => {
      const { workflowId } = await admittedWorkflow({ label: 'failed-phase' })
      const compute = createFakeComputeProvisioner()
      compute.failNextLaunch(new Error('InsufficientInstanceCapacity'))

      await expect(start(workflowId, compute)).rejects.toThrow()

      const phases = await fixtures
        .db()
        .select()
        .from(bootstrapPhases)
        .where(eq(bootstrapPhases.workflowId, workflowId))

      expect(phases[0]).toMatchObject({ phase: 'provisioning', outcome: 'failed' })
      expect(phases[0]?.detail).toContain('InsufficientInstanceCapacity')
    })
  })

  describe('when it is reached twice', () => {
    it('does not launch a second instance for a lease that already records one', async () => {
      const { workflowId } = await admittedWorkflow({ label: 'retry' })
      const compute = createFakeComputeProvisioner({ instanceIds: ['i-first', 'i-second'] })

      await start(workflowId, compute)
      const second = await start(workflowId, compute)

      // FR-078. One admission, one instance, however many times the hand-off is retried.
      expect(second).toMatchObject({ outcome: 'already_started', instanceId: 'i-first' })
      expect(compute.launches).toHaveLength(1)
    })

    it('destroys the instance it launched when it loses the claim on the lease', async () => {
      const { workflowId } = await admittedWorkflow({ label: 'race' })
      const fake = createFakeComputeProvisioner({ instanceIds: ['i-loser'] })

      // The interleaving the compare-and-set exists for: another caller records *its* instance
      // between this one reading the lease and updating it. Injected at the launch, because that
      // is the window — the read has happened and the update has not.
      const racing: ComputeProvisioner = {
        ...fake,
        launch: async (request) => {
          await fixtures
            .db()
            .update(computeLeases)
            .set({ providerInstanceId: 'i-winner', readyAt: new Date() })
            .where(eq(computeLeases.workflowId, workflowId))
          return fake.launch(request)
        },
      }

      const outcome = await start(workflowId, racing)

      expect(outcome).toMatchObject({
        outcome: 'already_started',
        instanceId: 'i-winner',
        terminatedInstanceId: 'i-loser',
      })
      // Nobody else knows `i-loser` exists, so the loser is the only party that can destroy it.
      expect(fake.terminations).toStrictEqual(['i-loser'])
    })
  })

  it('refuses a run holding no live lease rather than launching an unaccounted instance', async () => {
    const workflowId = await fixtures.seedWorkflow({ label: 'no-lease', state: 'provisioning' })
    const compute = createFakeComputeProvisioner()

    const outcome = await start(workflowId, compute)

    expect(outcome).toMatchObject({ outcome: 'not_startable' })
    expect(compute.launches).toHaveLength(0)
  })

  it('refuses a run with no workspace entries before an instance is paid for', async () => {
    const workflowId = await fixtures.seedWorkflow({ label: 'no-entries', state: 'provisioning' })
    await fixtures.db().insert(computeLeases).values({
      workflowId,
      instanceType: 'fixture.small',
      purchaseMode: 'spot',
    })
    const compute = createFakeComputeProvisioner()

    await expect(start(workflowId, compute)).rejects.toThrow(/no workspace entries/)
    expect(compute.launches).toHaveLength(0)
  })
})

/**
 * FR-021 — a seat stranded by a launch that failed (T048).
 *
 * The test that earns its place is the one that fails the launch and then reads the pool: without
 * the release, the credential stays `held` by a run that has no instance and is not terminal, so
 * nothing surfaces it until the FR-039 sweep twenty minutes later — which is precisely the
 * invisibility FR-021 names. Its counterpart is the compare-and-set loser, which must *not* release:
 * that path means another start owns the run, and the run is very much still going.
 */
describeWithDatabase('handing a seat back when provisioning fails (FR-021)', () => {
  const pool = createCredentialPoolFixtures(connectionString ?? '')

  beforeAll(() => pool.open(), 60_000)
  afterAll(() => pool.close())

  /**
   * The pool fixtures share one workspace version across every workflow they seed, and
   * `workspace_entries` allows one primary entry per version — so the entries have to go between
   * tests as well as the leases, or the second run in this scope cannot be given a workspace at all.
   */
  afterEach(async () => {
    await pool.db().delete(bootstrapPhases)
    await pool.db().delete(workflowEvents)
    await pool.db().delete(computeLeases)
    await pool.db().delete(workflowEntries)
    await pool.db().delete(workspaceEntries)
    await pool.clearLeases()
  })

  /** A run admitted through the real path, holding one seat, ready to be started. */
  const readyToStart = async (
    label: string,
  ): Promise<{ readonly workflowId: string; readonly agentCredentialId: string }> => {
    const credentialGroupId = await pool.seedGroup({ label: `${label}-group` })
    const agentCredentialId = await pool.seedCredential({
      label: `${label}-cred`,
      credentialGroupId,
    })
    const executionProfileId = await pool.seedProfile({
      label: `${label}-profile`,
      groups: [{ credentialGroupId, position: 1 }],
    })
    const workflowId = await pool.seedWorkflow({ label, executionProfileId, state: 'queued' })

    // The label doubles as the subdirectory: the pool fixtures share one workspace version across
    // every workflow they seed, and `workspace_entries` is unique on (version, subdirectory).
    await seedEntry(pool.db(), workflowId, { subdirectory: label })
    await admitWorkflow({ db: pool.db(), workflowId, ceiling: 8 })

    return { workflowId, agentCredentialId }
  }

  const start = async (
    workflowId: string,
    compute: ComputeProvisioner,
  ): Promise<StartWorkflowOutcome> =>
    startWorkflow({
      db: pool.db(),
      compute,
      machineSurfaceUrl: MACHINE_SURFACE_URL,
      credentialSecret: SECRET,
      workflowId,
    })

  it('puts the seat identifiers, and only the identifiers, into the envelope (FR-012)', async () => {
    const { workflowId, agentCredentialId } = await readyToStart('envelope-seat')
    const compute = createFakeComputeProvisioner()

    const outcome = await start(workflowId, compute)

    expect(outcome).toMatchObject({ outcome: 'started', agentCredentialId })

    const envelope = JSON.parse(compute.launches[0].userData) as Partial<WorkflowJobEnvelope>
    const [lease] = await pool.liveLeases()

    expect(envelope.agentCredential).toStrictEqual({
      credentialId: agentCredentialId,
      leaseFence: lease.fence,
    })
    // The material lives in the secret store and reaches the instance through the machine surface,
    // authorised by the scoped credential this envelope does carry. User data is not a channel it
    // may travel on: it is readable by anything on the box for the instance's whole life.
    expect(compute.launches[0].userData).not.toContain('material')
    expect(compute.launches[0].userData).not.toContain('secretId')
  }, 30_000)

  it('releases the seat as `forced` when the launch fails, with the reason recorded', async () => {
    const { workflowId, agentCredentialId } = await readyToStart('launch-fails')
    const compute = createFakeComputeProvisioner()
    compute.failNextLaunch(new Error('InsufficientInstanceCapacity'))

    await expect(start(workflowId, compute)).rejects.toThrow(/InsufficientInstanceCapacity/)

    // Back in the pool rather than stranded on a run that has no instance and is not terminal.
    expect(await pool.liveLeases()).toHaveLength(0)
    expect(await pool.credential(agentCredentialId)).toMatchObject({
      state: 'available',
      heldBy: null,
    })

    const [lease] = await pool.leases()
    // `forced` rather than `terminal`: at the moment of release the run is `provisioning`, and a
    // trail claiming otherwise would disagree with the workflow row. The null user is what says the
    // platform took the seat back rather than an administrator (FR-057, FR-058).
    expect(lease).toMatchObject({ releaseReason: 'forced', releasedByUserId: null })
    expect(await pool.auditFor(agentCredentialId)).toMatchObject([
      { action: 'leased' },
      { action: 'force_released', actorUserId: null, detail: { releaseReason: 'forced' } },
    ])
  }, 30_000)

  it('names the released seat on the failed provisioning phase, beside the failure', async () => {
    const { workflowId, agentCredentialId } = await readyToStart('failed-phase-seat')
    const compute = createFakeComputeProvisioner()
    compute.failNextLaunch(new Error('InsufficientInstanceCapacity'))

    await expect(start(workflowId, compute)).rejects.toThrow()

    const [phase] = await pool
      .db()
      .select()
      .from(bootstrapPhases)
      .where(eq(bootstrapPhases.workflowId, workflowId))

    // "Why did it fail" and "what did it let go of" are the first two questions, and they are
    // answered in the same place a person is already looking.
    expect(phase).toMatchObject({ phase: 'provisioning', outcome: 'failed' })
    expect(phase.detail).toContain('InsufficientInstanceCapacity')
    expect(phase.detail).toContain(agentCredentialId)
  }, 30_000)

  it('keeps the seat when the compare-and-set loser destroys its own instance (FR-078)', async () => {
    const { workflowId, agentCredentialId } = await readyToStart('cas-loser')
    const compute = createFakeComputeProvisioner({ instanceIds: ['i-loser'] })

    // Another caller records *its* instance while this one is mid-launch.
    await pool
      .db()
      .update(computeLeases)
      .set({ providerInstanceId: 'i-winner' })
      .where(eq(computeLeases.workflowId, workflowId))

    await expect(start(workflowId, compute)).resolves.toMatchObject({
      outcome: 'already_started',
      instanceId: 'i-winner',
    })

    // The run is still going under the other start. Taking its identity away would be the worst
    // available fix for a duplicate hand-off.
    expect(await pool.liveLeases()).toHaveLength(1)
    expect(await pool.credential(agentCredentialId)).toMatchObject({ state: 'held' })
  }, 30_000)

  it('reports honestly when a failing launch had no seat to release', async () => {
    // The pre-T064 case: a run with no execution profile is admitted without one, and a launch
    // failure has nothing to hand back. It must not throw on the way out of a failure path.
    const workflowId = await pool.seedWorkflow({ label: 'seatless', state: 'queued' })
    await seedEntry(pool.db(), workflowId, { subdirectory: 'seatless' })
    await admitWorkflow({ db: pool.db(), workflowId, ceiling: 8 })

    const compute = createFakeComputeProvisioner()
    compute.failNextLaunch(new Error('InsufficientInstanceCapacity'))

    await expect(start(workflowId, compute)).rejects.toThrow(/InsufficientInstanceCapacity/)

    const [phase] = await pool
      .db()
      .select()
      .from(bootstrapPhases)
      .where(eq(bootstrapPhases.workflowId, workflowId))
    expect(phase.detail).toContain('held no agent credential')
    expect(await pool.leases()).toHaveLength(0)
  }, 30_000)
})

/**
 * **Resume, and the states it declines to act in (T096, T097, 003/FR-041, FR-046).**
 *
 * The end-to-end pause→resume behaviour — starting the same instance, recovering onto a fresh one
 * under the same seat, and the substitution record — is asserted in `pause-instance.test.ts`, where
 * the full credential-pool graph exists and a resume can be held against the pause that preceded
 * it. What is asserted here is the other half: the states a resume must refuse, and above all the
 * refusal that is a *deliberate gap* rather than an oversight.
 *
 * `parked_resumable` is the one to read twice. Since T103 it **is** resumable — FR-046 provisions
 * fresh and never waits for or reserves a credential — so the positive case moved to the suite that
 * can prove the part worth proving: that the fresh instance runs under the identical lease the run
 * held before it parked. What remains here is the refusal that survives it, and it is not an
 * oversight either: a parked run whose seat `reconcile.ts` has already handed back (FR-073) cannot
 * be resumed at all, because resuming it would mean acquiring a *different* identity, and FR-023
 * forbids that under every circumstance there is.
 */
describeWithDatabase('the states a resume declines to act in (FR-041, FR-046)', () => {
  const fixtures = createWorkflowFixtures(connectionString ?? '')

  beforeAll(() => fixtures.open(), 60_000)
  afterEach(() => fixtures.removeAll())
  afterAll(() => fixtures.close())

  const seedSnapshot = async (workflowId: string): Promise<void> => {
    const snapshot = firstRow(
      await fixtures
        .db()
        .insert(sessionSnapshots)
        .values({
          workflowId,
          sessionId: crypto.randomUUID(),
          s3Key: `snapshots/${workflowId}/pause.tar.zst`,
          sizeBytes: 4_096,
          boundary: 'pause',
          hasConversationState: true,
          hasWorktreeState: true,
          isCurrent: true,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        })
        .returning({ id: sessionSnapshots.id }),
    )

    await fixtures
      .db()
      .update(workflows)
      .set({ currentSnapshotId: snapshot?.id })
      .where(eq(workflows.id, workflowId))
  }

  const resume = (
    workflowId: string,
    compute: ComputeProvisioner = createFakeComputeProvisioner(),
  ) =>
    resumeWorkflow({
      db: fixtures.db(),
      compute,
      machineSurfaceUrl: MACHINE_SURFACE_URL,
      credentialSecret: SECRET,
      workflowId,
    })

  it.each([{ state: 'running' as const }, { state: 'succeeded' as const }])(
    'refuses a run in state $state',
    async ({ state }) => {
      const workflowId = await fixtures.seedWorkflow({ label: `resume-${state}`, state })
      await seedSnapshot(workflowId)
      const compute = createFakeComputeProvisioner()

      const outcome = await resume(workflowId, compute)

      expect(outcome).toMatchObject({ outcome: 'not_resumable', state })
      expect(outcome.outcome === 'not_resumable' ? outcome.reason : '').toMatch(
        /Only a paused or parked run/,
      )
      expect(compute.starts).toStrictEqual([])
      expect(compute.launches).toStrictEqual([])
    },
  )

  it('refuses a parked run that no longer holds a seat (T103, FR-023, FR-073)', async () => {
    // `parked_resumable` **does** resume now — that is T103, and the positive case is asserted in
    // `pause-instance.test.ts`, which has a credential pool and can therefore state the thing worth
    // stating: the run comes back under the identical lease it held before the park (SC-018).
    //
    // What this fixture can state is the other half. These workflows hold no credential lease at
    // all, which is exactly the shape a parked run has once `reconcile.ts` hands its seat back for
    // a snapshot past its retention period. At that point the run has genuinely ended, and the only
    // way to resume it would be to run it under a different identity — which FR-023 forbids without
    // qualification. So it is refused, and nothing is launched.
    const workflowId = await fixtures.seedWorkflow({
      label: 'resume-parked-seatless',
      state: 'parked_resumable',
    })
    await seedSnapshot(workflowId)
    const compute = createFakeComputeProvisioner()

    const outcome = await resume(workflowId, compute)

    expect(outcome).toMatchObject({ outcome: 'not_resumable', state: 'parked_resumable' })
    expect(outcome.outcome === 'not_resumable' ? outcome.reason : '').toMatch(/FR-023/)
    expect(compute.starts).toStrictEqual([])
    expect(compute.launches).toStrictEqual([])
  })

  it('refuses a paused run with nothing resumable to fall back to', async () => {
    const workflowId = await fixtures.seedWorkflow({ label: 'resume-no-snapshot', state: 'paused' })
    await fixtures.db().insert(computeLeases).values({
      workflowId,
      instanceType: 'fixture.small',
      purchaseMode: 'on_demand',
      providerInstanceId: 'i-resume-no-snapshot',
    })
    const compute = createFakeComputeProvisioner()
    compute.seedInstance({ instanceId: 'i-resume-no-snapshot', workflowId, state: 'stopped' })

    const outcome = await resume(workflowId, compute)

    // The instance is right there and would probably start. It is left alone anyway: without a
    // snapshot, a start that failed would leave the run with nothing at all, and taking one before
    // the stop (FR-039) was the whole point.
    expect(outcome).toMatchObject({ outcome: 'not_resumable', state: 'paused' })
    expect(compute.starts).toStrictEqual([])
  })

  it('fails loudly for a workflow that does not exist', async () => {
    await expect(resume('00000000-0000-7000-8000-000000000000')).rejects.toThrow(/does not exist/)
  })
})
