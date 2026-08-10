import { computeLeases, sessionSnapshots, workflows } from '@bluetel-ai/sisyphus-api/db'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createFakeComputeProvisioner } from '../aws'

import {
  giveUpEnvironment,
  resumableSnapshotFor,
  SNAPSHOT_RECOVERY_CAUSES,
} from './snapshot-recovery'
import { createWorkflowFixtures, readTestDatabaseUrl } from './workflow-fixtures'

/**
 * **T097 — the one way an execution environment is given up (003/FR-043).**
 *
 * This module is reached by three causes and has one behaviour, so the tests are written over the
 * causes rather than repeated for each: the assertions that matter are that the instance goes, the
 * lease is released **naming why**, and that a run whose snapshot could not be resumed from is left
 * strictly alone. That last one is the reason for the module's existence as a separate thing —
 * every caller reaches destruction through this check, so no caller can skip it.
 *
 * **What is deliberately not here.** The seat surviving a give-up is asserted in
 * `pause-instance.test.ts`, against a graph seeded through `admitWorkflow` so the lease under test
 * is the one the production path produces. Restating it here would need a third copy of the
 * credential-pool graph to prove something the fuller suite already proves against a real seat;
 * what this file asserts instead is that nothing in this module *can* touch one, which is visible
 * in the run with no seat at all reporting `undefined` rather than failing.
 */

const connectionString = readTestDatabaseUrl()
const describeWithDatabase = connectionString === undefined ? describe.skip : describe

/** See `admit-workflow.ts`: `noUncheckedIndexedAccess` is off, so indexing needs an honest type. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

describe('the recovery causes', () => {
  it('names the four ways a run ends up standing on its snapshot', () => {
    // Enumerated rather than free text because they are reported per cause: `spot_cannot_stop` is
    // the expected price of the default purchase mode, `parked_past_idle_limit` is FR-044 policy
    // being applied to a forgotten pause, and the other two are incidents.
    expect([...SNAPSHOT_RECOVERY_CAUSES]).toStrictEqual([
      'spot_cannot_stop',
      'instance_would_not_start',
      'instance_would_not_stop',
      'parked_past_idle_limit',
    ])
  })
})

describeWithDatabase('giving an execution environment up (003/FR-043)', () => {
  const fixtures = createWorkflowFixtures(connectionString ?? '')

  beforeAll(() => fixtures.open(), 60_000)
  afterEach(() => fixtures.removeAll())
  afterAll(() => fixtures.close())

  /** A paused run holding one instance, with a snapshot that is resumable unless told otherwise. */
  const pausedRun = async (options: {
    readonly label: string
    readonly resumable?: boolean
    readonly instanceId?: string | null
  }): Promise<string> => {
    const workflowId = await fixtures.seedWorkflow({ label: options.label, state: 'paused' })
    const instanceId = options.instanceId === undefined ? `i-${options.label}` : options.instanceId

    await fixtures.db().insert(computeLeases).values({
      workflowId,
      instanceType: 'fixture.small',
      purchaseMode: 'spot',
      providerInstanceId: instanceId,
    })

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
          hasWorktreeState: options.resumable !== false,
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

    return workflowId
  }

  const leaseOf = async (workflowId: string) =>
    firstRow(
      await fixtures
        .db()
        .select()
        .from(computeLeases)
        .where(eq(computeLeases.workflowId, workflowId)),
    )

  it('terminates the instance and releases the lease naming the cause', async () => {
    const workflowId = await pausedRun({ label: 'given-up' })
    const compute = createFakeComputeProvisioner()

    const outcome = await giveUpEnvironment({
      db: fixtures.db(),
      compute,
      workflowId,
      cause: 'spot_cannot_stop',
    })

    expect(outcome).toMatchObject({
      outcome: 'given_up',
      cause: 'spot_cannot_stop',
      terminatedInstanceId: 'i-given-up',
      // Reported so the caller can say which seat survived — read, never written.
      agentCredentialId: undefined,
    })
    expect(compute.terminations).toStrictEqual(['i-given-up'])

    const lease = await leaseOf(workflowId)
    expect(lease?.releasedAt).not.toBeNull()
    // Prose on the lease rather than a code, because `release_reason` is what a person reads when
    // they ask why a run's instance went away.
    expect(lease?.releaseReason).toContain('interruptible capacity')
  })

  it('records a different reason for a stranded instance than for a spot pause', async () => {
    const workflowId = await pausedRun({ label: 'stranded' })

    await giveUpEnvironment({
      db: fixtures.db(),
      compute: createFakeComputeProvisioner(),
      workflowId,
      cause: 'instance_would_not_start',
    })

    // Same path, different fact. A blended reason would make a capacity incident indistinguishable
    // from the ordinary cost of running on spot.
    expect((await leaseOf(workflowId))?.releaseReason).toContain('could not be started again')
  })

  it('refuses to destroy anything for a run it could not rebuild (FR-045’s instinct)', async () => {
    const workflowId = await pausedRun({ label: 'unresumable', resumable: false })
    const compute = createFakeComputeProvisioner()

    const outcome = await giveUpEnvironment({
      db: fixtures.db(),
      compute,
      workflowId,
      cause: 'spot_cannot_stop',
    })

    expect(outcome).toMatchObject({ outcome: 'refused' })
    // An instance that goes on billing is a cost somebody can see and fix. A run whose only copy of
    // itself was on a disk that no longer exists is not recoverable at any price.
    expect(compute.terminations).toStrictEqual([])
    expect((await leaseOf(workflowId))?.releasedAt).toBeNull()
  })

  it('releases a lease that never got an instance without asking EC2 for anything', async () => {
    const workflowId = await pausedRun({ label: 'no-instance', instanceId: null })
    const compute = createFakeComputeProvisioner()

    const outcome = await giveUpEnvironment({
      db: fixtures.db(),
      compute,
      workflowId,
      cause: 'instance_would_not_start',
    })

    expect(outcome).toMatchObject({ outcome: 'given_up', terminatedInstanceId: undefined })
    expect(compute.terminations).toStrictEqual([])
    expect((await leaseOf(workflowId))?.releasedAt).not.toBeNull()
  })

  it('is safe to call twice — the second finds nothing live and changes nothing', async () => {
    const workflowId = await pausedRun({ label: 'twice' })
    const compute = createFakeComputeProvisioner()

    await giveUpEnvironment({
      db: fixtures.db(),
      compute,
      workflowId,
      cause: 'spot_cannot_stop',
    })
    const releasedAt = (await leaseOf(workflowId))?.releasedAt

    const second = await giveUpEnvironment({
      db: fixtures.db(),
      compute,
      workflowId,
      cause: 'spot_cannot_stop',
    })

    // Jobs are retried. A second call must not re-terminate an instance a later run may since have
    // been given, nor restate when the lease was released.
    expect(second).toMatchObject({ outcome: 'given_up', terminatedInstanceId: undefined })
    expect(compute.terminations).toStrictEqual(['i-twice'])
    expect((await leaseOf(workflowId))?.releasedAt).toStrictEqual(releasedAt)
  })
})

describeWithDatabase('what counts as a snapshot worth standing on', () => {
  const fixtures = createWorkflowFixtures(connectionString ?? '')

  beforeAll(() => fixtures.open(), 60_000)
  afterEach(() => fixtures.removeAll())
  afterAll(() => fixtures.close())

  const withSnapshot = async (options: {
    readonly label: string
    readonly hasConversationState: boolean
    readonly hasWorktreeState: boolean
    readonly current?: boolean
  }): Promise<string> => {
    const workflowId = await fixtures.seedWorkflow({ label: options.label, state: 'paused' })

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
          hasConversationState: options.hasConversationState,
          hasWorktreeState: options.hasWorktreeState,
          isCurrent: options.current !== false,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        })
        .returning({ id: sessionSnapshots.id }),
    )

    if (options.current !== false) {
      await fixtures
        .db()
        .update(workflows)
        .set({ currentSnapshotId: snapshot?.id })
        .where(eq(workflows.id, workflowId))
    }

    return workflowId
  }

  it.each([
    { hasConversationState: true, hasWorktreeState: true, resumable: true },
    // An archive with a working tree and no conversation resumes into an agent that has forgotten
    // what it was doing; one with a conversation and no working tree resumes into an agent whose
    // edits are gone. Both look like success, which is what makes them worse than refusing.
    { hasConversationState: true, hasWorktreeState: false, resumable: false },
    { hasConversationState: false, hasWorktreeState: true, resumable: false },
  ])(
    'conversation=$hasConversationState worktree=$hasWorktreeState is resumable: $resumable',
    async ({ hasConversationState, hasWorktreeState, resumable }) => {
      const workflowId = await withSnapshot({
        label: `flags-${String(hasConversationState)}-${String(hasWorktreeState)}`,
        hasConversationState,
        hasWorktreeState,
      })

      const snapshot = await resumableSnapshotFor(fixtures.db(), workflowId)

      expect(snapshot === undefined).toBe(!resumable)
    },
  )

  it('reads the run’s current snapshot and not merely its newest', async () => {
    // A snapshot the run has not adopted is not the state the run is in. `current_snapshot_id` is
    // the platform's single answer to "what would a resume be built from".
    const workflowId = await withSnapshot({
      label: 'not-current',
      hasConversationState: true,
      hasWorktreeState: true,
      current: false,
    })

    await expect(resumableSnapshotFor(fixtures.db(), workflowId)).resolves.toBeUndefined()
  })

  it('carries the snapshot’s own session id, not the run’s (002/FR-150)', async () => {
    const workflowId = await withSnapshot({
      label: 'session',
      hasConversationState: true,
      hasWorktreeState: true,
    })

    const snapshot = await resumableSnapshotFor(fixtures.db(), workflowId)
    const row = firstRow(
      await fixtures
        .db()
        .select({ sessionId: sessionSnapshots.sessionId })
        .from(sessionSnapshots)
        .where(eq(sessionSnapshots.workflowId, workflowId)),
    )

    expect(snapshot?.sessionId).toBe(row?.sessionId)
  })
})
