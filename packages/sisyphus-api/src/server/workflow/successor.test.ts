import { randomUUID } from 'node:crypto'

import { eq, notInArray } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { sessionSnapshots, workflowEntries, workflowEvents, workflows } from '../../db'
import { TERMINAL_WORKFLOW_STATES } from '../../enums'

import {
  changedFields,
  CONTINUABLE_FIELDS,
  continueWithChanges,
  readSuccessorChain,
} from './successor'
import type { TwoProfileFixture } from './test-support'
import { createTwoProfileFixture, readTestDatabaseUrl, refusalOf } from './test-support'

/**
 * T101 and the server half of T102.
 *
 * The assertions that carry the requirements:
 *
 * - **the predecessor is not written to at all** (FR-149) — its whole row is captured before and
 *   compared after, rather than spot-checking the two fields the resolver happens to mention;
 * - **the successor keeps its own `session_id` and resumes under the predecessor's** (FR-150) —
 *   asserted as an inequality as well as two equalities, because the failure being guarded against
 *   is the two ids silently becoming one;
 * - **a continuation that changes nothing is refused** (FR-151), and is refused pointing at
 *   `resume`;
 * - **the chain traverses both ways and is scoped in both** (FR-152, FR-190).
 */

const connectionString = readTestDatabaseUrl()

/**
 * The first row, honestly typed. `noUncheckedIndexedAccess` is off in this project, so `rows[0]` is
 * typed as present even when the result set is empty, and a guard against it narrows away.
 */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

describe('changedFields', () => {
  const predecessor = {
    model: 'claude-opus-5',
    turnCap: 40,
    spendCap: '25.0000',
  } as const

  it('names only the fields that actually differ', () => {
    expect(changedFields(predecessor, { turnCap: 80 })).toStrictEqual(['turnCap'])
  })

  it('is empty when the request restates what is already in force (FR-151)', () => {
    expect(
      changedFields(predecessor, {
        model: 'claude-opus-5',
        turnCap: 40,
        spendCap: '25.0000',
      }),
    ).toStrictEqual([])
  })

  it('compares spend numerically, so 25.00 and 25.0000 are not a change', () => {
    expect(changedFields(predecessor, { spendCap: '25.00' })).toStrictEqual([])
    expect(changedFields(predecessor, { spendCap: '50.00' })).toStrictEqual(['spendCap'])
  })

  it('treats a cap arriving where there was none as a change', () => {
    expect(changedFields({ ...predecessor, spendCap: null }, { spendCap: '5.0000' })).toStrictEqual(
      ['spendCap'],
    )
  })

  it('admits exactly the three fields FR-150 names', () => {
    expect([...CONTINUABLE_FIELDS]).toStrictEqual(['model', 'turnCap', 'spendCap'])
  })
})

describe.skipIf(connectionString === undefined)('continueWithChanges', () => {
  let fixture: TwoProfileFixture

  beforeAll(async () => {
    fixture = createTwoProfileFixture(connectionString ?? '')
    await fixture.open()
  }, 60_000)

  afterAll(async () => {
    await fixture.close()
  }, 30_000)

  /**
   * Put every run in the scratch database into `capped`, so no branch is held.
   *
   * Two reasons, and neither is test hygiene for its own sake. **A successor is a continuation of a
   * run that stopped**: `capped` is the state the FR-150 story is actually told about, and the
   * fixture seeds its runs `running` — a state in which FR-120 now, correctly, refuses to put a
   * second run on the same branch. And every test below leaves a `queued` successor on the
   * predecessor's branch, so without this the second test in the file would be refused by the first
   * test's leftovers rather than by whatever it was written to exercise.
   *
   * The one case this suite deliberately does **not** clear is asserted directly, further down.
   */
  const releaseBranches = async (): Promise<void> => {
    await fixture
      .db()
      .update(workflows)
      .set({ state: 'capped' })
      .where(notInArray(workflows.state, [...TERMINAL_WORKFLOW_STATES]))
  }

  beforeEach(async () => {
    await releaseBranches()
  })

  /** Give workflow A a complete, current snapshot, as `registerSnapshot` would have. */
  const seedSnapshot = async (options?: {
    readonly expiresAt?: Date
    readonly hasWorktreeState?: boolean
  }): Promise<{ readonly snapshotId: string; readonly snapshotSessionId: string }> => {
    const db = fixture.db()
    const workflowId = fixture.ids().a.workflowId
    const row = await db.select().from(workflows).where(eq(workflows.id, workflowId))
    const snapshotSessionId = row[0]?.sessionId ?? ''

    const inserted = await db
      .insert(sessionSnapshots)
      .values({
        workflowId,
        sessionId: snapshotSessionId,
        s3Key: `snapshots/${randomUUID()}.tar.zst`,
        sizeBytes: 4_096,
        boundary: 'stop',
        hasConversationState: true,
        hasWorktreeState: options?.hasWorktreeState ?? true,
        isCurrent: false,
        expiresAt: options?.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      })
      .returning({ id: sessionSnapshots.id })

    const snapshotId = inserted[0]?.id ?? ''

    await db
      .update(workflows)
      .set({ currentSnapshotId: snapshotId })
      .where(eq(workflows.id, workflowId))

    return { snapshotId, snapshotSessionId }
  }

  const readPredecessor = async () =>
    (
      await fixture
        .db()
        .select()
        .from(workflows)
        .where(eq(workflows.id, fixture.ids().a.workflowId))
    )[0]

  it('creates a successor that keeps its own session id and resumes under the predecessor’s', async () => {
    const { snapshotId, snapshotSessionId } = await seedSnapshot()
    const scope = await fixture.scopeFor(fixture.ids().alice)

    const successor = await continueWithChanges({
      db: fixture.db(),
      scope,
      actorUserId: fixture.ids().alice,
      input: { workflowId: fixture.ids().a.workflowId, spendCap: '250.0000' },
    })

    expect(successor.predecessorWorkflowId).toBe(fixture.ids().a.workflowId)
    expect(successor.inheritedSnapshotId).toBe(snapshotId)
    // The relationship, stated three ways so it cannot be half-broken.
    expect(successor.resumeSessionId).toBe(snapshotSessionId)
    expect(successor.sessionId).toBe(successor.workflow.sessionId)
    expect(successor.sessionId).not.toBe(successor.resumeSessionId)
    // Inheriting the snapshot means pointing at it — the row still belongs to the predecessor.
    expect(successor.workflow.currentSnapshotId).toBe(snapshotId)
    expect(successor.workflow.state).toBe('queued')
    expect(successor.changedFields).toStrictEqual(['spendCap'])
    expect(successor.workflow.spendCap).toBe('250.0000')
  })

  it('never edits the predecessor’s job specification (FR-149)', async () => {
    await seedSnapshot()
    const before = await readPredecessor()
    const scope = await fixture.scopeFor(fixture.ids().alice)

    await continueWithChanges({
      db: fixture.db(),
      scope,
      actorUserId: fixture.ids().alice,
      input: { workflowId: fixture.ids().a.workflowId, turnCap: 500, model: 'claude-sonnet-5' },
    })

    // The whole row, not two fields somebody remembered to check.
    await expect(readPredecessor()).resolves.toStrictEqual(before)
  })

  it('writes the timeline entry on the successor, never on the immutable predecessor', async () => {
    await seedSnapshot()
    const scope = await fixture.scopeFor(fixture.ids().alice)
    const eventsBefore = await fixture
      .db()
      .select({ id: workflowEvents.id })
      .from(workflowEvents)
      .where(eq(workflowEvents.workflowId, fixture.ids().a.workflowId))

    const successor = await continueWithChanges({
      db: fixture.db(),
      scope,
      actorUserId: fixture.ids().alice,
      input: { workflowId: fixture.ids().a.workflowId, turnCap: 999 },
    })

    const eventsAfter = await fixture
      .db()
      .select({ id: workflowEvents.id })
      .from(workflowEvents)
      .where(eq(workflowEvents.workflowId, fixture.ids().a.workflowId))

    expect(eventsAfter).toHaveLength(eventsBefore.length)

    const successorEvents = await fixture
      .db()
      .select({ event: workflowEvents.event, detail: workflowEvents.detail })
      .from(workflowEvents)
      .where(eq(workflowEvents.workflowId, successor.workflow.id))

    const detail = successorEvents[0]?.detail as {
      sessionId: string
      resumeSessionId: string
      changedFields: string[]
    }

    expect(successorEvents[0]?.event).toBe('created')
    // Both ids recorded, named apart, so the timeline itself says which one `--resume` gets.
    expect(detail.sessionId).toBe(successor.sessionId)
    expect(detail.resumeSessionId).toBe(successor.resumeSessionId)
    expect(detail.changedFields).toStrictEqual(['turnCap'])
  })

  it('copies the predecessor’s entry set without its results (FR-115)', async () => {
    await seedSnapshot()
    const scope = await fixture.scopeFor(fixture.ids().alice)

    await fixture
      .db()
      .update(workflowEntries)
      .set({ pullRequestUrl: 'https://git.test/a/pull/7', entryResult: 'landed' })
      .where(eq(workflowEntries.id, fixture.ids().a.workflowEntryId))

    const successor = await continueWithChanges({
      db: fixture.db(),
      scope,
      actorUserId: fixture.ids().alice,
      input: { workflowId: fixture.ids().a.workflowId, turnCap: 120 },
    })

    expect(successor.entries).toHaveLength(1)
    expect(successor.entries[0]?.repositoryUrl).toBe(fixture.ids().a.repositoryUrl)
    expect(successor.entries[0]?.pullRequestUrl).toBeNull()
    expect(successor.entries[0]?.entryResult).toBeNull()
    expect(successor.entries[0]?.resolvedCommit).toBeNull()
  })

  it('refuses a continuation that changes nothing, pointing at resume (FR-151)', async () => {
    await seedSnapshot()
    const scope = await fixture.scopeFor(fixture.ids().alice)

    const refusal = await refusalOf(async () =>
      continueWithChanges({
        db: fixture.db(),
        scope,
        actorUserId: fixture.ids().alice,
        input: { workflowId: fixture.ids().a.workflowId },
      }),
    )

    expect(refusal.code).toBe('BAD_REQUEST')
    expect(refusal.message).toContain('resume')
  })

  it('refuses an incomplete snapshot rather than continuing from half a workspace', async () => {
    const db = fixture.db()

    await db
      .update(sessionSnapshots)
      .set({ hasWorktreeState: false })
      .where(eq(sessionSnapshots.id, (await seedSnapshot()).snapshotId))

    const scope = await fixture.scopeFor(fixture.ids().alice)
    const refusal = await refusalOf(async () =>
      continueWithChanges({
        db,
        scope,
        actorUserId: fixture.ids().alice,
        input: { workflowId: fixture.ids().a.workflowId, turnCap: 77 },
      }),
    )

    expect(refusal.code).toBe('CONFLICT')
    expect(refusal.message).toContain('incomplete')
  })

  it('refuses an expired snapshot with the retention limit stated', async () => {
    await seedSnapshot({ expiresAt: new Date(Date.now() - 1_000) })
    const scope = await fixture.scopeFor(fixture.ids().alice)

    const refusal = await refusalOf(async () =>
      continueWithChanges({
        db: fixture.db(),
        scope,
        actorUserId: fixture.ids().alice,
        input: { workflowId: fixture.ids().a.workflowId, turnCap: 88 },
      }),
    )

    expect(refusal.code).toBe('CONFLICT')
    expect(refusal.message).toContain('retained until')
  })

  it('refuses a run with no resumable snapshot at all', async () => {
    const db = fixture.db()

    await db
      .update(workflows)
      .set({ currentSnapshotId: null })
      .where(eq(workflows.id, fixture.ids().b.workflowId))

    const scope = await fixture.scopeFor(fixture.ids().bob)
    const refusal = await refusalOf(async () =>
      continueWithChanges({
        db,
        scope,
        actorUserId: fixture.ids().bob,
        input: { workflowId: fixture.ids().b.workflowId, turnCap: 5 },
      }),
    )

    expect(refusal.code).toBe('CONFLICT')
    expect(refusal.message).toContain('no resumable snapshot')
  })

  /**
   * FR-120 on the successor path.
   *
   * The judgement recorded at the call site, asserted rather than described: `excludeWorkflowId` is
   * **not** passed, so a predecessor that is still live refuses its own successor. `resume` is what
   * continues the same run (FR-151); a successor is a second run, a second instance and a second
   * agent, and putting it on a branch a live run still holds is exactly the pair FR-120 forbids.
   */
  describe('the branch guard (FR-120)', () => {
    it('refuses a successor while its predecessor is still running, naming it', async () => {
      await seedSnapshot()
      const predecessorId = fixture.ids().a.workflowId

      await fixture
        .db()
        .update(workflows)
        .set({ state: 'running' })
        .where(eq(workflows.id, predecessorId))

      const scope = await fixture.scopeFor(fixture.ids().alice)
      const refusal = await refusalOf(async () =>
        continueWithChanges({
          db: fixture.db(),
          scope,
          actorUserId: fixture.ids().alice,
          input: { workflowId: predecessorId, turnCap: 61 },
        }),
      )

      expect(refusal.code).toBe('CONFLICT')
      expect(refusal.message).toContain(predecessorId)
      expect(refusal.message).toContain(fixture.ids().a.repositoryUrl)
    })

    it.each(['queued', 'provisioning', 'paused'] as const)(
      'refuses one while its predecessor is %s — those still hold their worktree',
      async (state) => {
        await seedSnapshot()
        const predecessorId = fixture.ids().a.workflowId

        await fixture.db().update(workflows).set({ state }).where(eq(workflows.id, predecessorId))

        const scope = await fixture.scopeFor(fixture.ids().alice)
        const refusal = await refusalOf(async () =>
          continueWithChanges({
            db: fixture.db(),
            scope,
            actorUserId: fixture.ids().alice,
            input: { workflowId: predecessorId, turnCap: 62 },
          }),
        )

        expect(refusal.code).toBe('CONFLICT')
        expect(refusal.message).toContain(predecessorId)
      },
    )

    it.each([...TERMINAL_WORKFLOW_STATES])(
      'admits one once its predecessor is %s — the ordinary continuation is unaffected',
      async (state) => {
        await seedSnapshot()
        const predecessorId = fixture.ids().a.workflowId

        await fixture.db().update(workflows).set({ state }).where(eq(workflows.id, predecessorId))

        const scope = await fixture.scopeFor(fixture.ids().alice)
        const successor = await continueWithChanges({
          db: fixture.db(),
          scope,
          actorUserId: fixture.ids().alice,
          input: { workflowId: predecessorId, turnCap: 63 },
        })

        expect(successor.predecessorWorkflowId).toBe(predecessorId)
      },
    )

    it('refuses a second successor while the first is still queued on the same branch', async () => {
      // Nothing about lineage exempts a run from the rule: two successors of one predecessor are
      // two runs on one branch just as surely as two unrelated launches would be.
      await seedSnapshot()
      const predecessorId = fixture.ids().a.workflowId
      const scope = await fixture.scopeFor(fixture.ids().alice)

      const first = await continueWithChanges({
        db: fixture.db(),
        scope,
        actorUserId: fixture.ids().alice,
        input: { workflowId: predecessorId, turnCap: 64 },
      })

      const refusal = await refusalOf(async () =>
        continueWithChanges({
          db: fixture.db(),
          scope,
          actorUserId: fixture.ids().alice,
          input: { workflowId: predecessorId, turnCap: 65 },
        }),
      )

      expect(refusal.code).toBe('CONFLICT')
      expect(refusal.message).toContain(first.workflow.id)
    })

    it('writes nothing when the branch is held — no orphan run, no entries', async () => {
      await seedSnapshot()
      const predecessorId = fixture.ids().a.workflowId

      await fixture
        .db()
        .update(workflows)
        .set({ state: 'running' })
        .where(eq(workflows.id, predecessorId))

      const before = await fixture
        .db()
        .select({ id: workflows.id })
        .from(workflows)
        .where(eq(workflows.predecessorWorkflowId, predecessorId))

      const scope = await fixture.scopeFor(fixture.ids().alice)
      await refusalOf(async () =>
        continueWithChanges({
          db: fixture.db(),
          scope,
          actorUserId: fixture.ids().alice,
          input: { workflowId: predecessorId, turnCap: 66 },
        }),
      )

      const after = await fixture
        .db()
        .select({ id: workflows.id })
        .from(workflows)
        .where(eq(workflows.predecessorWorkflowId, predecessorId))

      expect(after).toHaveLength(before.length)
    })
  })

  it('reports an out-of-scope run as not found, never as forbidden (FR-190)', async () => {
    await seedSnapshot()
    const scope = await fixture.scopeFor(fixture.ids().outsider)

    const refusal = await refusalOf(async () =>
      continueWithChanges({
        db: fixture.db(),
        scope,
        actorUserId: fixture.ids().outsider,
        input: { workflowId: fixture.ids().a.workflowId, turnCap: 42 },
      }),
    )

    expect(refusal.code).toBe('NOT_FOUND')
    expect(refusal.message).toBe('Workflow not found.')
  })
})

describe.skipIf(connectionString === undefined)('readSuccessorChain', () => {
  let fixture: TwoProfileFixture
  let chainIds: readonly string[] = []

  beforeAll(async () => {
    fixture = createTwoProfileFixture(connectionString ?? '')
    await fixture.open()

    const db = fixture.db()
    const root = fixture.ids().a.workflowId
    const rootRow = firstRow(await db.select().from(workflows).where(eq(workflows.id, root)))

    if (rootRow === undefined) {
      throw new Error('the fixture did not seed workflow A')
    }

    // Two successors, so the chain has a middle: A → B → C. Traversal from B is the case that
    // needs both directions at once.
    const built: string[] = [root]
    let predecessorId = root

    for (const [index, spend] of [['1', '3.0000'] as const, ['2', '5.0000'] as const]) {
      const inserted = await db
        .insert(workflows)
        .values({
          type: rootRow.type,
          state: 'succeeded',
          ownerUserId: rootRow.ownerUserId,
          initiatedByUserId: rootRow.initiatedByUserId,
          executionProfileId: rootRow.executionProfileId,
          executionProfileVersionId: rootRow.executionProfileVersionId,
          setupBundleVersionId: rootRow.setupBundleVersionId,
          workspaceVersionId: rootRow.workspaceVersionId,
          model: rootRow.model,
          instanceType: rootRow.instanceType,
          purchaseMode: rootRow.purchaseMode,
          turnsUsed: Number(index),
          spendUsed: spend,
          sessionId: randomUUID(),
          predecessorWorkflowId: predecessorId,
        })
        .returning({ id: workflows.id })

      predecessorId = inserted[0]?.id ?? ''
      built.push(predecessorId)
    }

    chainIds = built
  }, 60_000)

  afterAll(async () => {
    await fixture.close()
  }, 30_000)

  it('traverses both directions from the middle of the chain (FR-152)', async () => {
    const scope = await fixture.scopeFor(fixture.ids().alice)

    const chain = await readSuccessorChain({
      db: fixture.db(),
      scope,
      workflowId: chainIds[1] ?? '',
    })

    expect(chain.links.map((link) => link.workflowId)).toStrictEqual([...chainIds])
    expect(chain.requestedWorkflowId).toBe(chainIds[1])
    expect(chain.links.filter((link) => link.isRequested)).toHaveLength(1)
    expect(chain.links[1]?.isRequested).toBe(true)
  })

  it('gives the same chain from either end', async () => {
    const scope = await fixture.scopeFor(fixture.ids().alice)
    const fromRoot = await readSuccessorChain({
      db: fixture.db(),
      scope,
      workflowId: chainIds[0] ?? '',
    })
    const fromLeaf = await readSuccessorChain({
      db: fixture.db(),
      scope,
      workflowId: chainIds[2] ?? '',
    })

    expect(fromRoot.links.map((link) => link.workflowId)).toStrictEqual(
      fromLeaf.links.map((link) => link.workflowId),
    )
  })

  it('sums consumption across the whole chain (FR-152)', async () => {
    const scope = await fixture.scopeFor(fixture.ids().alice)
    const chain = await readSuccessorChain({
      db: fixture.db(),
      scope,
      workflowId: chainIds[0] ?? '',
    })

    // 3 turns on the seeded run, then 1 and 2 on the successors.
    expect(chain.workflowCount).toBe(3)
    expect(chain.turnsTotal).toBe(6)
    expect(chain.spendTotal).toBe('19.0000')
  })

  it('is a chain of one for a run that continues nothing and was continued by nothing', async () => {
    const scope = await fixture.scopeFor(fixture.ids().bob)
    const chain = await readSuccessorChain({
      db: fixture.db(),
      scope,
      workflowId: fixture.ids().b.workflowId,
    })

    expect(chain.links).toHaveLength(1)
    expect(chain.links[0]?.isRequested).toBe(true)
    expect(chain.links[0]?.predecessorWorkflowId).toBeNull()
  })

  it('answers not found for a run outside the caller’s scope (FR-190)', async () => {
    const scope = await fixture.scopeFor(fixture.ids().outsider)

    const refusal = await refusalOf(async () =>
      readSuccessorChain({ db: fixture.db(), scope, workflowId: chainIds[0] ?? '' }),
    )

    expect(refusal.code).toBe('NOT_FOUND')
  })

  it('excludes an out-of-scope chain member from the links and from the totals (FR-190)', async () => {
    // Bob owns none of this chain and holds no grant on profile A, so from his scope the whole
    // chain is invisible — and the run he *can* see reports a total of one, not four.
    const scope = await fixture.scopeFor(fixture.ids().bob)
    const chain = await readSuccessorChain({
      db: fixture.db(),
      scope,
      workflowId: fixture.ids().b.workflowId,
    })

    expect(chain.workflowCount).toBe(1)
    expect(chain.links.map((link) => link.workflowId)).not.toContain(chainIds[0])
  })

  it('lets an admin see the chain whole', async () => {
    const scope = await fixture.scopeFor(fixture.ids().admin, true)
    const chain = await readSuccessorChain({
      db: fixture.db(),
      scope,
      workflowId: chainIds[2] ?? '',
    })

    expect(chain.workflowCount).toBe(3)
  })
})
