import { randomUUID } from 'node:crypto'

import { and, desc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { sessionSnapshots, workflowEvents, workflows } from '../../db'
import type { MachineCredential } from '../context'

import {
  chainSessionIds,
  missingSnapshotState,
  registerSnapshot,
  REGISTER_SNAPSHOT_PATH,
  SNAPSHOT_RETENTION_DAYS,
  snapshotExpiry,
} from './snapshot'
import type { MachineFixture } from './test-support'
import { createMachineFixture, readTestDatabaseUrl, refusalOf } from './test-support'

/**
 * T099. Three things are being settled here, and only one of them is "the row was written".
 *
 * 1. **A snapshot missing either state flag is not resumable, and that is enforced.** Not by
 *    refusing the call — the attempt is a fact worth keeping — but by leaving `is_current` false
 *    and leaving `workflows.current_snapshot_id` pointing wherever it already pointed. The
 *    assertion that carries it is the one where an incomplete snapshot arrives *after* a good one
 *    and the good one is still the resume point.
 * 2. **Every write is scoped to the credential's workflow**, and the reachable surface is the
 *    `sessionId` — the only field in the payload that can name something outside the run.
 * 3. **A successor may register under its predecessor's session id.** That is not a loophole in
 *    (2); it is the case FR-150 creates, and a check that refused it would break the first
 *    successor.
 */

const connectionString = readTestDatabaseUrl()

/**
 * The first row, honestly typed. `noUncheckedIndexedAccess` is off in this project, so `rows[0]` is
 * typed as present even when the result set is empty, and a guard against it narrows away.
 */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

describe('missingSnapshotState', () => {
  it('names both halves when neither was captured (FR-050)', () => {
    expect(
      missingSnapshotState({ hasConversationState: false, hasWorktreeState: false }),
    ).toStrictEqual(['conversation', 'worktree'])
  })

  it('names the worktree alone — the half that desynchronises the model from the filesystem', () => {
    expect(
      missingSnapshotState({ hasConversationState: true, hasWorktreeState: false }),
    ).toStrictEqual(['worktree'])
  })

  it('is empty only when both are present', () => {
    expect(
      missingSnapshotState({ hasConversationState: true, hasWorktreeState: true }),
    ).toStrictEqual([])
  })
})

describe('snapshotExpiry', () => {
  it('retains a snapshot for the stated window, so an expired one is refused with a date', () => {
    const taken = new Date('2026-08-05T00:00:00.000Z')

    expect(snapshotExpiry(taken).toISOString()).toBe('2026-09-04T00:00:00.000Z')
    expect(SNAPSHOT_RETENTION_DAYS).toBe(30)
  })
})

describe.skipIf(connectionString === undefined)('registerSnapshot', () => {
  let fixture: MachineFixture
  let credential: MachineCredential

  const keyFor = (label: string): string => `snapshots/${label}.tar.zst`

  beforeAll(async () => {
    fixture = createMachineFixture(connectionString ?? '')
    await fixture.open()
    credential = await fixture.seedCredential(fixture.ids().a.workflowId)
  }, 60_000)

  afterAll(async () => {
    await fixture.close()
  }, 30_000)

  const ownSessionId = async (): Promise<string> => {
    const rows = await fixture
      .db()
      .select({ sessionId: workflows.sessionId })
      .from(workflows)
      .where(eq(workflows.id, fixture.ids().a.workflowId))

    return rows[0]?.sessionId ?? ''
  }

  const currentSnapshotId = async (): Promise<string | null> => {
    const rows = await fixture
      .db()
      .select({ currentSnapshotId: workflows.currentSnapshotId })
      .from(workflows)
      .where(eq(workflows.id, fixture.ids().a.workflowId))

    return rows[0]?.currentSnapshotId ?? null
  }

  it('records a complete snapshot and makes it the workflow’s resume point (FR-050)', async () => {
    const { ctx } = fixture.contextFor(credential)

    const registered = await registerSnapshot(ctx, {
      sessionId: await ownSessionId(),
      s3Key: keyFor('complete'),
      sizeBytes: 4_096,
      boundary: 'pause',
      hasConversationState: true,
      hasWorktreeState: true,
      truncationRepaired: false,
    })

    expect(registered.resumable).toBe(true)
    expect(registered.missing).toStrictEqual([])
    expect(registered.snapshot.workflowId).toBe(fixture.ids().a.workflowId)
    expect(registered.snapshot.isCurrent).toBe(true)
    await expect(currentSnapshotId()).resolves.toBe(registered.snapshot.id)
  })

  it('records the discarded trailing line as a normal outcome, not a fault (FR-053)', async () => {
    const { ctx } = fixture.contextFor(credential)

    const registered = await registerSnapshot(ctx, {
      sessionId: await ownSessionId(),
      s3Key: keyFor('truncated'),
      sizeBytes: 5_000,
      boundary: 'interruption',
      hasConversationState: true,
      hasWorktreeState: true,
      truncationRepaired: true,
    })

    expect(registered.resumable).toBe(true)
    expect(registered.snapshot.truncationRepaired).toBe(true)
  })

  it('stands the previous current snapshot down, so at most one is current', async () => {
    const current = await fixture
      .db()
      .select({ id: sessionSnapshots.id })
      .from(sessionSnapshots)
      .where(
        and(
          eq(sessionSnapshots.workflowId, fixture.ids().a.workflowId),
          eq(sessionSnapshots.isCurrent, true),
        ),
      )

    expect(current).toHaveLength(1)
    await expect(currentSnapshotId()).resolves.toBe(current[0]?.id)
  })

  it('never makes an incomplete snapshot current, and never displaces the good one (FR-050)', async () => {
    const { ctx } = fixture.contextFor(credential)
    const before = await currentSnapshotId()

    const registered = await registerSnapshot(ctx, {
      sessionId: await ownSessionId(),
      s3Key: keyFor('no-worktree'),
      sizeBytes: 900,
      boundary: 'stop',
      hasConversationState: true,
      // The archive did not contain a working tree. Conversation state alone restores an agent
      // whose beliefs about the filesystem are wrong.
      hasWorktreeState: false,
      truncationRepaired: false,
    })

    expect(registered.resumable).toBe(false)
    expect(registered.missing).toStrictEqual(['worktree'])
    expect(registered.snapshot.isCurrent).toBe(false)
    // The row exists — the attempt is a fact — but the resume point has not moved.
    expect(registered.snapshot.s3Key).toBe(keyFor('no-worktree'))
    await expect(currentSnapshotId()).resolves.toBe(before)
  })

  it('refuses a conversation-less snapshot the same way', async () => {
    const { ctx } = fixture.contextFor(credential)
    const before = await currentSnapshotId()

    const registered = await registerSnapshot(ctx, {
      sessionId: await ownSessionId(),
      s3Key: keyFor('no-conversation'),
      sizeBytes: 900,
      boundary: 'completion',
      hasConversationState: false,
      hasWorktreeState: true,
      truncationRepaired: false,
    })

    expect(registered.resumable).toBe(false)
    expect(registered.missing).toStrictEqual(['conversation'])
    await expect(currentSnapshotId()).resolves.toBe(before)
  })

  it('writes a timeline entry for an incomplete snapshot too — a silent gap is unnoticeable', async () => {
    const events = await fixture
      .db()
      .select({ detail: workflowEvents.detail })
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.workflowId, fixture.ids().a.workflowId),
          eq(workflowEvents.event, 'snapshot_registered'),
        ),
      )
      .orderBy(desc(workflowEvents.createdAt))

    const details = events.map((row) => row.detail as { resumable: boolean; missing: string[] })

    expect(details.some((detail) => detail.resumable)).toBe(true)
    expect(details.some((detail) => !detail.resumable && detail.missing.includes('worktree'))).toBe(
      true,
    )
  })

  it('refuses another workflow’s session id, and records it (FR-018, SC-014)', async () => {
    const { ctx, denials } = fixture.contextFor(credential)
    const other = await fixture
      .db()
      .select({ sessionId: workflows.sessionId })
      .from(workflows)
      .where(eq(workflows.id, fixture.ids().b.workflowId))

    const refusal = await refusalOf(async () =>
      registerSnapshot(ctx, {
        sessionId: other[0]?.sessionId ?? '',
        s3Key: keyFor('cross-workflow'),
        sizeBytes: 10,
        boundary: 'pause',
        hasConversationState: true,
        hasWorktreeState: true,
        truncationRepaired: false,
      }),
    )

    expect(refusal.code).toBe('FORBIDDEN')
    expect(denials).toHaveLength(1)
    expect(denials[0]?.reason).toBe('cross_workflow_write')
    expect(denials[0]?.workflowId).toBe(fixture.ids().a.workflowId)
    expect(denials[0]?.path).toBe(REGISTER_SNAPSHOT_PATH)
  })

  it('refuses a session id matching nothing identically, so it is no enumeration oracle', async () => {
    const { ctx, denials } = fixture.contextFor(credential)

    const refusal = await refusalOf(async () =>
      registerSnapshot(ctx, {
        sessionId: randomUUID(),
        s3Key: keyFor('unknown-session'),
        sizeBytes: 10,
        boundary: 'pause',
        hasConversationState: true,
        hasWorktreeState: true,
        truncationRepaired: false,
      }),
    )

    expect(refusal.code).toBe('FORBIDDEN')
    expect(refusal.message).toBe('This credential does not cover that workflow.')
    expect(denials).toHaveLength(1)
  })

  it('writes nothing when the session id is refused', async () => {
    const rows = await fixture
      .db()
      .select({ id: sessionSnapshots.id })
      .from(sessionSnapshots)
      .where(eq(sessionSnapshots.s3Key, keyFor('cross-workflow')))

    expect(rows).toStrictEqual([])
  })
})

describe.skipIf(connectionString === undefined)(
  'a successor registering under its predecessor',
  () => {
    let fixture: MachineFixture

    beforeAll(async () => {
      fixture = createMachineFixture(connectionString ?? '')
      await fixture.open()
    }, 60_000)

    afterAll(async () => {
      await fixture.close()
    }, 30_000)

    /** A successor of workflow A, with its own session id and A as its predecessor (FR-150). */
    const seedSuccessor = async (): Promise<{
      readonly workflowId: string
      readonly ownSessionId: string
      readonly predecessorSessionId: string
    }> => {
      const db = fixture.db()
      const ids = fixture.ids()

      const row = firstRow(
        await db.select().from(workflows).where(eq(workflows.id, ids.a.workflowId)),
      )

      if (row === undefined) {
        throw new Error('the fixture did not seed workflow A')
      }

      const ownSessionId = randomUUID()

      const inserted = await db
        .insert(workflows)
        .values({
          type: row.type,
          state: 'queued',
          ownerUserId: row.ownerUserId,
          initiatedByUserId: row.initiatedByUserId,
          executionProfileId: row.executionProfileId,
          executionProfileVersionId: row.executionProfileVersionId,
          setupBundleVersionId: row.setupBundleVersionId,
          workspaceVersionId: row.workspaceVersionId,
          model: row.model,
          instanceType: row.instanceType,
          purchaseMode: row.purchaseMode,
          sessionId: ownSessionId,
          predecessorWorkflowId: row.id,
        })
        .returning({ id: workflows.id })

      return {
        workflowId: inserted[0]?.id ?? '',
        ownSessionId,
        predecessorSessionId: row.sessionId,
      }
    }

    it('accepts the predecessor’s recorded session id — the id --resume names (FR-150)', async () => {
      const successor = await seedSuccessor()
      const credential = await fixture.seedCredential(successor.workflowId)
      const { ctx } = fixture.contextFor(credential)

      const registered = await registerSnapshot(ctx, {
        sessionId: successor.predecessorSessionId,
        s3Key: 'snapshots/successor.tar.zst',
        sizeBytes: 7_000,
        boundary: 'pause',
        hasConversationState: true,
        hasWorktreeState: true,
        truncationRepaired: false,
      })

      // The row belongs to the **successor**; the session id on it is the predecessor's. The two are
      // recorded separately, which is exactly what stops `--resume` naming an id nothing is filed
      // under.
      expect(registered.snapshot.workflowId).toBe(successor.workflowId)
      expect(registered.snapshot.sessionId).toBe(successor.predecessorSessionId)
      expect(registered.snapshot.sessionId).not.toBe(successor.ownSessionId)
      expect(registered.resumable).toBe(true)
    })

    it('walks the chain to build the permitted set, self first', async () => {
      const successor = await seedSuccessor()

      await expect(chainSessionIds(fixture.db(), successor.workflowId)).resolves.toStrictEqual([
        successor.ownSessionId,
        successor.predecessorSessionId,
      ])
    })

    it('still refuses a session id from outside the chain', async () => {
      const successor = await seedSuccessor()
      const credential = await fixture.seedCredential(successor.workflowId)
      const { ctx, denials } = fixture.contextFor(credential)
      const other = await fixture
        .db()
        .select({ sessionId: workflows.sessionId })
        .from(workflows)
        .where(eq(workflows.id, fixture.ids().b.workflowId))

      const refusal = await refusalOf(async () =>
        registerSnapshot(ctx, {
          sessionId: other[0]?.sessionId ?? '',
          s3Key: 'snapshots/successor-cross.tar.zst',
          sizeBytes: 10,
          boundary: 'pause',
          hasConversationState: true,
          hasWorktreeState: true,
          truncationRepaired: false,
        }),
      )

      expect(refusal.code).toBe('FORBIDDEN')
      expect(denials).toHaveLength(1)
    })
  },
)
