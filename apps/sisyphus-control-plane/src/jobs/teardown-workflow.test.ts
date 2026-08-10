import type { Workflow } from '@bluetel-ai/sisyphus-api/db'
import {
  artifacts,
  computeLeases,
  logSegments,
  sessionSnapshots,
  workflows,
} from '@bluetel-ai/sisyphus-api/db'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { ComputeProvisioner, FakeObjectStore, ObjectStore } from '../aws'
import { createFakeComputeProvisioner, createFakeObjectStore } from '../aws'
import { liveCredentialFor, mintScopedCredential } from '../credentials'
import { createCredentialPoolFixtures } from '../credentials/allocate/pool-fixtures'

import { admitWorkflow } from './admit-workflow'
import type { TeardownOutcome } from './teardown-workflow'
import { teardownWorkflow, TEARDOWN_BUDGET_MS } from './teardown-workflow'
import { createWorkflowFixtures, readTestDatabaseUrl } from './workflow-fixtures'

/**
 * FR-038 is an ordering requirement, so the two tests that matter most here are the one that
 * records the actual sequence of calls and the one that removes an object and shows `terminate` is
 * never reached. Releasing first and confirming afterwards would pass a test that only checked the
 * end state; it would lose a run's output the first time an upload was in flight when the executor
 * died.
 *
 * Every test runs against the recording fakes. Nothing here builds an AWS client.
 */

const connectionString = readTestDatabaseUrl()
const describeWithDatabase = connectionString === undefined ? describe.skip : describe

const BUCKETS = {
  logs: 'logs-bucket',
  artifacts: 'artifacts-bucket',
  snapshots: 'snapshots-bucket',
}
const SECRET = 'test-signing-secret-not-a-real-one'

/** See `admit-workflow.ts`: `noUncheckedIndexedAccess` is off, so indexing needs an honest type. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/** Wrap both seams so the order of the calls between them is observable. */
const recording = (
  objectStore: ObjectStore,
  compute: ComputeProvisioner,
): {
  readonly objectStore: ObjectStore
  readonly compute: ComputeProvisioner
  readonly calls: readonly string[]
} => {
  const calls: string[] = []

  return {
    calls,
    objectStore: {
      ...objectStore,
      head: async (input) => {
        calls.push(`head:${input.key}`)
        return objectStore.head(input)
      },
    },
    compute: {
      ...compute,
      terminate: async (input) => {
        calls.push(`terminate:${input.instanceId}`)
        await compute.terminate(input)
      },
    },
  }
}

describeWithDatabase('tearing a finished run down', () => {
  const fixtures = createWorkflowFixtures(connectionString ?? '')

  beforeAll(() => fixtures.open(), 60_000)
  afterEach(() => fixtures.removeAll())
  afterAll(() => fixtures.close())

  /** A finished run holding an instance, with one persisted log segment. */
  const finishedRun = async (options: {
    readonly label: string
    readonly instanceId?: string
    readonly persistLog?: boolean
  }): Promise<{ readonly workflowId: string; readonly logKey: string }> => {
    const workflowId = await fixtures.seedWorkflow({ label: options.label, state: 'succeeded' })
    const instanceId = options.instanceId ?? `i-${options.label}`

    await fixtures.db().insert(computeLeases).values({
      workflowId,
      instanceType: 'fixture.small',
      purchaseMode: 'spot',
      providerInstanceId: instanceId,
    })

    const logKey = `logs/${workflowId}/0001.ndjson`
    await fixtures.db().insert(logSegments).values({
      workflowId,
      sequence: 1,
      s3Key: logKey,
      byteSize: 128,
      startedAt: new Date(),
      endedAt: new Date(),
    })

    await mintScopedCredential({ db: fixtures.db(), workflowId, secret: SECRET })

    return { workflowId, logKey }
  }

  const teardown = (
    workflowId: string,
    seams: {
      readonly objectStore: ObjectStore
      readonly compute: ComputeProvisioner
      readonly now?: () => Date
      readonly terminalAt?: Date
      readonly queueDrain?: { readonly drain: () => Promise<void> }
    },
  ) =>
    teardownWorkflow({
      db: fixtures.db(),
      compute: seams.compute,
      objectStore: seams.objectStore,
      buckets: BUCKETS,
      workflowId,
      ...(seams.now === undefined ? {} : { now: seams.now }),
      ...(seams.terminalAt === undefined ? {} : { terminalAt: seams.terminalAt }),
      ...(seams.queueDrain === undefined ? {} : { queueDrain: seams.queueDrain }),
    })

  const withPersistedLog = async (
    label: string,
  ): Promise<{
    readonly workflowId: string
    readonly objectStore: FakeObjectStore
  }> => {
    const objectStore = createFakeObjectStore()
    const { workflowId, logKey } = await finishedRun({ label })
    objectStore.put({ bucket: BUCKETS.logs, key: logKey })
    return { workflowId, objectStore }
  }

  it('confirms every durable object before it destroys anything', async () => {
    const { workflowId, objectStore } = await withPersistedLog('order')
    const compute = createFakeComputeProvisioner()
    const seams = recording(objectStore, compute)

    const outcome = await teardown(workflowId, seams)

    expect(outcome).toMatchObject({ outcome: 'released', confirmedObjects: 1 })
    // The ordering, stated as data. Any implementation that released first fails here.
    expect(seams.calls).toStrictEqual([`head:logs/${workflowId}/0001.ndjson`, 'terminate:i-order'])
  })

  it('releases the lease and revokes the credential once durability holds', async () => {
    const { workflowId, objectStore } = await withPersistedLog('release')
    const compute = createFakeComputeProvisioner()

    const outcome = await teardown(workflowId, { objectStore, compute })

    expect(outcome).toMatchObject({ outcome: 'released', credentialsRevoked: 1 })
    expect(compute.terminations).toStrictEqual(['i-release'])
    expect(await liveCredentialFor(fixtures.db(), workflowId)).toBeUndefined()

    const lease = firstRow(
      await fixtures
        .db()
        .select()
        .from(computeLeases)
        .where(eq(computeLeases.workflowId, workflowId)),
    )
    expect(lease?.releasedAt).not.toBeNull()
    expect(lease?.releaseReason).toContain('1 durable objects confirmed')
  })

  it('confirms artifacts and the current snapshot as well as log segments', async () => {
    const objectStore = createFakeObjectStore()
    const { workflowId, logKey } = await finishedRun({ label: 'all-classes' })
    objectStore.put({ bucket: BUCKETS.logs, key: logKey })

    await fixtures
      .db()
      .insert(artifacts)
      .values({
        workflowId,
        kind: 'diff',
        s3Key: `artifacts/${workflowId}/diff.patch`,
      })
    // An artifact that lives elsewhere has no object to confirm; checking one would fail forever.
    await fixtures.db().insert(artifacts).values({
      workflowId,
      kind: 'pull_request',
      externalUrl: 'https://example.invalid/pull/1',
    })
    await fixtures
      .db()
      .insert(sessionSnapshots)
      .values({
        workflowId,
        sessionId: crypto.randomUUID(),
        s3Key: `snapshots/${workflowId}/final.tar.zst`,
        sizeBytes: 1024,
        boundary: 'completion',
        hasConversationState: true,
        hasWorktreeState: true,
        isCurrent: true,
        expiresAt: new Date(Date.now() + 86_400_000),
      })

    objectStore.put({ bucket: BUCKETS.artifacts, key: `artifacts/${workflowId}/diff.patch` })
    objectStore.put({ bucket: BUCKETS.snapshots, key: `snapshots/${workflowId}/final.tar.zst` })

    const outcome = await teardown(workflowId, {
      objectStore,
      compute: createFakeComputeProvisioner(),
    })

    expect(outcome).toMatchObject({ outcome: 'released', confirmedObjects: 3 })
  })

  describe('when durability cannot be confirmed', () => {
    it('destroys nothing and says what is missing', async () => {
      const objectStore = createFakeObjectStore()
      const { workflowId, logKey } = await finishedRun({ label: 'missing' })
      const compute = createFakeComputeProvisioner()

      const outcome = await teardown(workflowId, { objectStore, compute })

      expect(outcome).toMatchObject({
        outcome: 'deferred',
        missing: [{ kind: 'log_segment', bucket: BUCKETS.logs, key: logKey }],
      })
      // The whole point of the ordering. The segment may still be in flight; the instance holding
      // the only copy of it is the last thing that should be destroyed.
      expect(compute.terminations).toStrictEqual([])
      expect(await liveCredentialFor(fixtures.db(), workflowId)).toBeDefined()

      const lease = firstRow(
        await fixtures
          .db()
          .select()
          .from(computeLeases)
          .where(eq(computeLeases.workflowId, workflowId)),
      )
      expect(lease?.releasedAt).toBeNull()
    })

    it('states the ten-minute budget it is deferring inside', async () => {
      const objectStore = createFakeObjectStore()
      const { workflowId } = await finishedRun({ label: 'budget' })
      const terminalAt = new Date('2026-08-05T10:00:00.000Z')

      const outcome = await teardown(workflowId, {
        objectStore,
        compute: createFakeComputeProvisioner(),
        terminalAt,
        now: () => new Date(terminalAt.getTime() + 60_000),
      })

      expect(TEARDOWN_BUDGET_MS).toBe(10 * 60 * 1000)
      expect(outcome).toMatchObject({
        outcome: 'deferred',
        deadline: new Date(terminalAt.getTime() + TEARDOWN_BUDGET_MS),
        remainingMs: TEARDOWN_BUDGET_MS - 60_000,
      })
    })

    it('releases anyway once the budget is spent, recording the loss', async () => {
      const objectStore = createFakeObjectStore()
      const { workflowId, logKey } = await finishedRun({ label: 'forced' })
      const compute = createFakeComputeProvisioner()
      const terminalAt = new Date('2026-08-05T10:00:00.000Z')

      const outcome = await teardown(workflowId, {
        objectStore,
        compute,
        terminalAt,
        now: () => new Date(terminalAt.getTime() + TEARDOWN_BUDGET_MS + 1),
      })

      // SC-007 wins over the confirmation past the deadline: an object that is never going to
      // appear would otherwise hold a paid instance for ever while the job reported it was being
      // careful.
      expect(outcome).toMatchObject({ outcome: 'forced', missing: [{ key: logKey }] })
      expect(compute.terminations).toStrictEqual(['i-forced'])

      const lease = firstRow(
        await fixtures
          .db()
          .select()
          .from(computeLeases)
          .where(eq(computeLeases.workflowId, workflowId)),
      )
      // Recorded, not hidden. This is the difference between "your logs are gone" and silence.
      expect(lease?.releaseReason).toContain('unconfirmed objects')
      expect(lease?.releaseReason).toContain(logKey)
    })
  })

  it('does nothing for a run that has not finished', async () => {
    const workflowId = await fixtures.seedWorkflow({ label: 'running', state: 'running' })
    await fixtures.db().insert(computeLeases).values({
      workflowId,
      instanceType: 'fixture.small',
      purchaseMode: 'spot',
      providerInstanceId: 'i-running',
    })
    const compute = createFakeComputeProvisioner()

    const outcome = await teardownWorkflow({
      db: fixtures.db(),
      compute,
      objectStore: createFakeObjectStore(),
      buckets: BUCKETS,
      workflowId,
    })

    expect(outcome).toMatchObject({ outcome: 'not_terminal', state: 'running' })
    expect(compute.terminations).toStrictEqual([])
  })

  it('converges on a second call rather than failing on an already-released lease', async () => {
    const { workflowId, objectStore } = await withPersistedLog('idempotent')
    const compute = createFakeComputeProvisioner()

    await teardown(workflowId, { objectStore, compute })
    const second = await teardown(workflowId, { objectStore, compute })

    expect(second).toMatchObject({ outcome: 'already_released', credentialsRevoked: 0 })
    expect(compute.terminations).toStrictEqual(['i-idempotent'])
  })

  it('revokes a credential the reconciler left behind when it took the lease', async () => {
    const workflowId = await fixtures.seedWorkflow({ label: 'swept', state: 'failed' })
    await mintScopedCredential({ db: fixtures.db(), workflowId, secret: SECRET })

    const outcome = await teardownWorkflow({
      db: fixtures.db(),
      compute: createFakeComputeProvisioner(),
      objectStore: createFakeObjectStore(),
      buckets: BUCKETS,
      workflowId,
    })

    expect(outcome).toMatchObject({ outcome: 'already_released', credentialsRevoked: 1 })
    expect(await liveCredentialFor(fixtures.db(), workflowId)).toBeUndefined()
  })

  describe('the queue drain', () => {
    it('runs after the release, never before', async () => {
      const { workflowId, objectStore } = await withPersistedLog('drain')
      const compute = createFakeComputeProvisioner()
      let releasedWhenDrained: Date | null | undefined

      await teardown(workflowId, {
        objectStore,
        compute,
        queueDrain: {
          drain: async () => {
            const lease = firstRow(
              await fixtures
                .db()
                .select()
                .from(computeLeases)
                .where(eq(computeLeases.workflowId, workflowId)),
            )
            releasedWhenDrained = lease?.releasedAt
          },
        },
      })

      // The slot the drain fills has to be the one this release just freed. Draining first would
      // re-admit against a ceiling the released lease was still counted in.
      expect(releasedWhenDrained).not.toBeNull()
      expect(releasedWhenDrained).toBeDefined()
    })

    it('does not run for a deferred teardown, because nothing was freed', async () => {
      const objectStore = createFakeObjectStore()
      const { workflowId } = await finishedRun({ label: 'no-drain' })
      let drained = false

      await teardown(workflowId, {
        objectStore,
        compute: createFakeComputeProvisioner(),
        queueDrain: {
          drain: () => {
            drained = true
            return Promise.resolve()
          },
        },
      })

      expect(drained).toBe(false)
    })

    it('reports a drain failure rather than failing a teardown that succeeded', async () => {
      const { workflowId, objectStore } = await withPersistedLog('drain-fails')

      const outcome = await teardown(workflowId, {
        objectStore,
        compute: createFakeComputeProvisioner(),
        queueDrain: { drain: () => Promise.reject(new Error('the drain fell over')) },
      })

      expect(outcome).toMatchObject({ outcome: 'released' })
      expect(outcome.outcome === 'released' ? outcome.queueDrainError?.message : undefined).toBe(
        'the drain fell over',
      )
    })
  })
})

/**
 * FR-019 — the seat comes back on terminal state, and on nothing else (T047).
 *
 * The tests that earn their place are the three negatives, because FR-019 is a prohibition and the
 * central promise of this feature is that a lease survives a pause, a park and every execution
 * environment the run ever has. Each is asserted here rather than argued in a comment:
 *
 * - **pause** never reaches the release, and the assertion is that teardown answers `not_terminal`
 *   with the credential still `held` and the instance still running;
 * - **park** does reach teardown — `parked_resumable` is a terminal outcome, so every other
 *   terminal check in the job answers true for it — releases the *instance*, and keeps the seat;
 * - **environment destruction** is the same test read the other way: `terminate` is called in the
 *   park case and the lease is untouched, which is FR-018 as an observation rather than a claim.
 *
 * This scope uses the credential pool fixtures for the graph they can seed, and inserts its own
 * compute leases and log segments, which is what `reconcile.test.ts` does for the same reason.
 */
describeWithDatabase('handing the agent credential back at teardown (FR-019)', () => {
  const pool = createCredentialPoolFixtures(connectionString ?? '')

  beforeAll(() => pool.open(), 60_000)
  afterAll(() => pool.close())

  afterEach(async () => {
    await pool.db().delete(logSegments)
    await pool.db().delete(computeLeases)
    await pool.clearLeases()
  })

  /** A run in the given state, holding one seat, one instance and one persisted log segment. */
  const runHoldingASeat = async (options: {
    readonly label: string
    readonly state: Workflow['state']
  }): Promise<{
    readonly workflowId: string
    readonly agentCredentialId: string
    readonly objectStore: FakeObjectStore
  }> => {
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

    // Through admission, so the lease under test is one the production path produced.
    await admitWorkflow({ db: pool.db(), workflowId, ceiling: 8 })
    await pool
      .db()
      .update(computeLeases)
      .set({ providerInstanceId: `i-${options.label}` })
      .where(eq(computeLeases.workflowId, workflowId))
    await pool
      .db()
      .update(workflows)
      .set({ state: options.state })
      .where(eq(workflows.id, workflowId))

    const logKey = `logs/${workflowId}/0001.ndjson`
    await pool.db().insert(logSegments).values({
      workflowId,
      sequence: 1,
      s3Key: logKey,
      byteSize: 128,
      startedAt: new Date(),
      endedAt: new Date(),
    })

    const objectStore = createFakeObjectStore()
    objectStore.put({ bucket: BUCKETS.logs, key: logKey })

    return { workflowId, agentCredentialId, objectStore }
  }

  const tearDown = async (
    workflowId: string,
    objectStore: ObjectStore,
    compute: ComputeProvisioner,
  ): Promise<TeardownOutcome> =>
    teardownWorkflow({ db: pool.db(), compute, objectStore, buckets: BUCKETS, workflowId })

  it('releases the seat as `terminal` when the run finishes, recording it in the trail (FR-058)', async () => {
    const { workflowId, agentCredentialId, objectStore } = await runHoldingASeat({
      label: 'terminal-release',
      state: 'succeeded',
    })

    const outcome = await tearDown(workflowId, objectStore, createFakeComputeProvisioner())

    expect(outcome).toMatchObject({
      outcome: 'released',
      agentCredential: { outcome: 'released', agentCredentialId },
    })

    const [lease] = await pool.leases()
    expect(lease).toMatchObject({ releaseReason: 'terminal', releasedByUserId: null })
    expect(lease.releasedAt).not.toBeNull()

    // Back in the pool, and the release recorded against the credential rather than a person.
    expect(await pool.credential(agentCredentialId)).toMatchObject({
      state: 'available',
      heldBy: null,
    })
    expect(await pool.auditFor(agentCredentialId)).toMatchObject([
      { action: 'leased' },
      { action: 'released', actorUserId: null, detail: { releaseReason: 'terminal' } },
    ])
  }, 30_000)

  it('does not reach the release for a paused run (FR-019)', async () => {
    const { workflowId, agentCredentialId, objectStore } = await runHoldingASeat({
      label: 'paused-keeps',
      state: 'paused',
    })
    const compute = createFakeComputeProvisioner()

    const outcome = await tearDown(workflowId, objectStore, compute)

    expect(outcome).toStrictEqual({ outcome: 'not_terminal', workflowId, state: 'paused' })

    // A pause holds its instance *and* its seat. Neither moved.
    expect(await pool.liveLeases()).toHaveLength(1)
    expect(await pool.credential(agentCredentialId)).toMatchObject({ state: 'held' })
    expect(compute.terminations).toStrictEqual([])
  }, 30_000)

  it('keeps the seat of a parked run while releasing its instance (FR-073, SC-018)', async () => {
    // The case that would be got wrong. `parked_resumable` *is* terminal, so teardown proceeds and
    // destroys the environment — that is the whole difference between parking and pausing — and the
    // credential must survive it, because FR-151 resumes the same workflow onto the same identity.
    const { workflowId, agentCredentialId, objectStore } = await runHoldingASeat({
      label: 'parked-keeps',
      state: 'parked_resumable',
    })
    const compute = createFakeComputeProvisioner()

    const outcome = await tearDown(workflowId, objectStore, compute)

    expect(outcome).toMatchObject({
      outcome: 'released',
      agentCredential: { outcome: 'retained', agentCredentialId },
    })

    // The environment is gone; the seat is not. FR-018: a lease belongs to the workflow, not to an
    // execution environment, and destroying one takes nothing with it.
    expect(compute.terminations).toStrictEqual(['i-parked-keeps'])
    expect(await pool.liveLeases()).toHaveLength(1)
    expect(await pool.credential(agentCredentialId)).toMatchObject({ state: 'held' })
    expect(await pool.auditFor(agentCredentialId)).toMatchObject([{ action: 'leased' }])
  }, 30_000)

  it('releases a parked run that later becomes terminal some other way (FR-073)', async () => {
    const { workflowId, agentCredentialId, objectStore } = await runHoldingASeat({
      label: 'parked-then-failed',
      state: 'parked_resumable',
    })

    await tearDown(workflowId, objectStore, createFakeComputeProvisioner())
    expect(await pool.credential(agentCredentialId)).toMatchObject({ state: 'held' })

    // "…and MUST release it when it becomes terminal — including when it becomes terminal by its
    // durable snapshot passing the retention period and ceasing to be resumable."
    await pool.db().update(workflows).set({ state: 'failed' }).where(eq(workflows.id, workflowId))

    await expect(
      tearDown(workflowId, objectStore, createFakeComputeProvisioner()),
    ).resolves.toMatchObject({
      outcome: 'already_released',
      agentCredential: { outcome: 'released', agentCredentialId },
    })

    expect(await pool.credential(agentCredentialId)).toMatchObject({ state: 'available' })
  }, 30_000)

  it('is safe to run twice, freeing no seat the second time', async () => {
    const { workflowId, agentCredentialId, objectStore } = await runHoldingASeat({
      label: 'twice',
      state: 'succeeded',
    })

    await tearDown(workflowId, objectStore, createFakeComputeProvisioner())

    // Teardown is a job and jobs are retried. A second release would append a second audit entry,
    // or free a seat some later run had since taken.
    await expect(
      tearDown(workflowId, objectStore, createFakeComputeProvisioner()),
    ).resolves.toMatchObject({
      outcome: 'already_released',
      agentCredential: { outcome: 'not_held' },
    })

    expect(await pool.auditFor(agentCredentialId)).toHaveLength(2)
  }, 30_000)

  it('does not repair a credential that fell ill while it was held (FR-033, SC-010)', async () => {
    const { workflowId, agentCredentialId, objectStore } = await runHoldingASeat({
      label: 'unwell',
      state: 'succeeded',
    })

    await pool.execute(
      `update agent_credentials set state = 'unhealthy' where id = '${agentCredentialId}'`,
    )

    await expect(
      tearDown(workflowId, objectStore, createFakeComputeProvisioner()),
    ).resolves.toMatchObject({ agentCredential: { outcome: 'released', agentCredentialId } })

    // Released, but not returned to the pool: handing a broken login to the next run would fail it
    // for a reason nothing in its own history explains.
    expect(await pool.credential(agentCredentialId)).toMatchObject({ state: 'unhealthy' })
  }, 30_000)
})
