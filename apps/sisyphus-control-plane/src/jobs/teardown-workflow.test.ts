import {
  artifacts,
  computeLeases,
  logSegments,
  sessionSnapshots,
} from '@bluetel-ai/sisyphus-api/db'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { ComputeProvisioner, FakeObjectStore, ObjectStore } from '../aws'
import { createFakeComputeProvisioner, createFakeObjectStore } from '../aws'
import { liveCredentialFor, mintScopedCredential } from '../credentials'

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
