/* cspell:ignore datname */
import { randomUUID } from 'node:crypto'

import { eq, notInArray, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SisyphusDatabase } from '../../db'
import {
  computeLeases,
  executionProfiles,
  profileOverrides,
  scopedCredentials,
  sessionSnapshots,
  workflowEntries,
  workflowEvents,
  workflows,
} from '../../db'
import { TERMINAL_WORKFLOW_STATES } from '../../enums'
import { startWorkflowInput } from '../../schemas'
import type { ResolvedScope } from '../scope'

import { acquireBranchLocks } from './branch-lock'
import {
  assemblePrompt,
  mayLaunchOnProfile,
  readWorkspaceBranchPairs,
  startWorkflow,
} from './start'
import type { TwoProfileFixture, TwoProfileIds } from './test-support'
import {
  createTwoProfileFixture,
  LOCKED_FIELD_A,
  readTestDatabaseUrl,
  refusalOf,
} from './test-support'

/**
 * `workflow.start` (T064).
 *
 * The behaviour under test is as much about what does **not** happen as about what does. FR-035
 * requires the control plane to expose no inbound network surface, and the way that requirement
 * survives contact with a panel is for the panel to hold no means of asking for compute: `start`
 * writes a `queued` row and returns. So the first suite below asserts the *absence* of an outbound
 * call, of a compute lease and of a credential — the three things a "helpfully" extended
 * implementation would add, each of which would quietly make the no-ingress rule a convention
 * again.
 */

const connectionString = readTestDatabaseUrl()

/** A promise plus its resolver, for holding a transaction open at a chosen moment. */
const createGate = (): { readonly opened: Promise<void>; readonly open: () => void } => {
  let open = (): void => undefined
  const opened = new Promise<void>((resolve) => {
    open = () => {
      resolve()
    }
  })
  return { opened, open }
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

describe('assemblePrompt', () => {
  it('puts the profile preamble above the caller’s prompt (FR-159, FR-165)', () => {
    expect(assemblePrompt('Context.', 'Do the thing.')).toBe('Context.\n\nDo the thing.')
  })

  it('omits an absent or blank preamble rather than leaving a gap', () => {
    expect(assemblePrompt(null, 'Do the thing.')).toBe('Do the thing.')
    expect(assemblePrompt('   ', 'Do the thing.')).toBe('Do the thing.')
  })
})

describe('mayLaunchOnProfile', () => {
  const scope = (overrides: Partial<ResolvedScope>): ResolvedScope => ({
    userId: 'user',
    isAdmin: false,
    visibleProfileIds: [],
    ...overrides,
  })

  it('admits a holder of a live grant (FR-180)', () => {
    expect(mayLaunchOnProfile(scope({ visibleProfileIds: ['p'] }), 'p')).toBe(true)
  })

  it('refuses a profile the caller does not hold (FR-180)', () => {
    expect(mayLaunchOnProfile(scope({ visibleProfileIds: ['other'] }), 'p')).toBe(false)
  })

  it('admits an admin without a grant (FR-183)', () => {
    expect(mayLaunchOnProfile(scope({ isAdmin: true }), 'p')).toBe(true)
  })
})

describe.skipIf(connectionString === undefined)('startWorkflow against a live database', () => {
  let fixture: TwoProfileFixture
  let db: SisyphusDatabase
  let ids: TwoProfileIds
  let aliceScope: ResolvedScope
  let adminScope: ResolvedScope

  beforeAll(async () => {
    fixture = createTwoProfileFixture(connectionString ?? '')
    await fixture.open()
    db = fixture.db()
    ids = fixture.ids()
    aliceScope = await fixture.scopeFor(ids.alice)
    adminScope = await fixture.scopeFor(ids.admin, true)
  }, 60_000)

  afterAll(async () => {
    await fixture.close()
  }, 30_000)

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /**
   * Put every run in the scratch database into `succeeded`, so no branch is held.
   *
   * `start` now runs inside `withBranchLocks` (FR-120), and the fixture seeds each of its two runs
   * `running` on the very repository and branch the matching profile's workspace pins — so without
   * this every launch below would be refused by the fixture, and every launch after the first
   * would be refused by the launch before it. Freeing the branch between tests is what lets each
   * one assert the thing it is about; the guard itself is asserted deliberately, at the end.
   */
  const releaseBranches = async (): Promise<void> => {
    await db
      .update(workflows)
      .set({ state: 'succeeded' })
      .where(notInArray(workflows.state, [...TERMINAL_WORKFLOW_STATES]))
  }

  beforeEach(async () => {
    await releaseBranches()
  })

  /**
   * Backends parked specifically on an advisory lock in this scratch database.
   *
   * `wait_event = 'advisory'` and not merely `wait_event_type = 'Lock'`: a backend waiting on a row
   * lock or a relation lock is also `Lock`, and counting those would let an unrelated wait stand in
   * for the one the test is about.
   */
  const waitingOnAdvisoryLocks = async (): Promise<number> => {
    const rows = (await db.execute(sql`
      select count(*)::int as blocked
        from pg_stat_activity
       where datname = current_database()
         and wait_event_type = 'Lock'
         and wait_event = 'advisory'`)) as unknown as readonly { readonly blocked: number }[]

    return rows[0]?.blocked ?? 0
  }

  const launch = async (overrides: Record<string, unknown> = {}, scope = aliceScope) =>
    startWorkflow({
      db,
      scope,
      actorUserId: ids.alice,
      input: startWorkflowInput.parse({
        executionProfileId: ids.a.executionProfileId,
        prompt: 'Fix the flaky test.',
        ...overrides,
      }),
    })

  describe('what it writes', () => {
    it('creates a queued run owned and initiated by the caller', async () => {
      const started = await launch()

      expect(started.workflow.state).toBe('queued')
      expect(started.workflow.ownerUserId).toBe(ids.alice)
      expect(started.workflow.initiatedByUserId).toBe(ids.alice)
      expect(started.workflow.terminalOutcome).toBeNull()
    })

    it('pins the profile version’s bundle and workspace versions (FR-065, FR-126)', async () => {
      const started = await launch()

      expect(started.workflow.executionProfileId).toBe(ids.a.executionProfileId)
      expect(started.workflow.executionProfileVersionId).toBe(ids.a.executionProfileVersionId)
      expect(started.workflow.workspaceVersionId).toBe(ids.a.workspaceVersionId)
      expect(started.workflow.setupBundleVersionId).toBe(ids.bundleVersion)
    })

    it('assigns a session id before anything starts (FR-052)', async () => {
      const started = await launch()

      expect(started.workflow.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('records the prompt as sent, preamble included (FR-065)', async () => {
      const started = await launch({ prompt: 'Fix the flaky test.' })

      expect(started.workflow.assembledPrompt).toBe('Preamble A\n\nFix the flaky test.')
    })

    it('copies the pinned workspace version’s entries onto the run (FR-114)', async () => {
      const started = await launch()

      expect(started.entries).toHaveLength(1)
      expect(started.entries[0]).toMatchObject({
        repositoryUrl: ids.a.repositoryUrl,
        workspaceEntryId: ids.a.workspaceEntryId,
        isPrimary: true,
      })

      const stored = await db
        .select()
        .from(workflowEntries)
        .where(eq(workflowEntries.workflowId, started.workflow.id))
      expect(stored).toHaveLength(1)
    })

    it('writes one created event attributed to the caller (FR-064)', async () => {
      const started = await launch()

      const events = await db
        .select()
        .from(workflowEvents)
        .where(eq(workflowEvents.workflowId, started.workflow.id))

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        event: 'created',
        actorType: 'user',
        actorUserId: ids.alice,
      })
    })

    it('records every accepted override alongside the profile value (FR-123)', async () => {
      const started = await launch({ overrides: { turnCap: 7 } })

      expect(started.workflow.turnCap).toBe(7)

      const recorded = await db
        .select()
        .from(profileOverrides)
        .where(eq(profileOverrides.workflowId, started.workflow.id))

      expect(recorded).toHaveLength(1)
      expect(recorded[0]).toMatchObject({
        field: 'turnCap',
        profileValue: '40',
        usedValue: '7',
        setByUserId: ids.alice,
      })
    })

    it('answers with a queue position, so waiting is distinguishable from stuck (FR-040)', async () => {
      // Two runs on two *different* workspaces, because two on one would be the FR-120 conflict
      // rather than a queue. The position is a property of the admission queue as a whole, so
      // counting across the two is exactly what it is supposed to do.
      const first = await launch()
      const second = await startWorkflow({
        db,
        scope: adminScope,
        actorUserId: ids.admin,
        input: startWorkflowInput.parse({
          executionProfileId: ids.b.executionProfileId,
          prompt: 'Queue behind the first.',
        }),
      })

      expect(first.queuePosition).toBeGreaterThanOrEqual(1)
      expect(second.queuePosition).toBeGreaterThan(first.queuePosition)
    })
  })

  describe('what it does not do — the FR-035 boundary', () => {
    it('makes no outbound call of any kind', async () => {
      // The panel holds no permission to provision, and the edge between it and the control plane
      // is a database row the control plane polls. If this ever fails, the no-ingress rule has
      // stopped being structural.
      const fetchSpy = vi.spyOn(globalThis, 'fetch')

      await launch()

      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('takes no compute lease — admission is the control plane’s, under the FR-040 ceiling', async () => {
      const started = await launch()

      const leases = await db
        .select()
        .from(computeLeases)
        .where(eq(computeLeases.workflowId, started.workflow.id))

      expect(leases).toStrictEqual([])
    })

    it('mints no credential — that is the control plane’s alone (FR-037)', async () => {
      const started = await launch()

      const credentials = await db
        .select()
        .from(scopedCredentials)
        .where(eq(scopedCredentials.workflowId, started.workflow.id))

      expect(credentials).toStrictEqual([])
    })

    it('leaves the run in queued, never in provisioning', async () => {
      const started = await launch()

      const stored = await db
        .select({ state: workflows.state })
        .from(workflows)
        .where(eq(workflows.id, started.workflow.id))

      expect(stored.map((row) => row.state)).toStrictEqual(['queued'])
    })
  })

  describe('who may launch (FR-180)', () => {
    it('refuses a profile the caller does not hold with NOT_FOUND, not FORBIDDEN', async () => {
      await expect(launch({ executionProfileId: ids.b.executionProfileId })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
    })

    it('is indistinguishable from a profile that does not exist', async () => {
      const captured: { code?: string; message?: string }[] = []

      for (const executionProfileId of [ids.b.executionProfileId, randomUUID()]) {
        try {
          await launch({ executionProfileId })
        } catch (caught) {
          captured.push(caught as { code?: string; message?: string })
        }
      }

      expect(captured).toHaveLength(2)
      expect(captured[0]?.code).toBe(captured[1]?.code)
      expect(captured[0]?.message).toBe(captured[1]?.message)
    })

    it('lets an admin launch without a grant (FR-183)', async () => {
      const started = await startWorkflow({
        db,
        scope: adminScope,
        actorUserId: ids.admin,
        input: startWorkflowInput.parse({
          executionProfileId: ids.b.executionProfileId,
          prompt: 'Admin launch.',
        }),
      })

      expect(started.workflow.executionProfileId).toBe(ids.b.executionProfileId)
    })
  })

  describe('what it refuses', () => {
    it('refuses an override of a field the profile locks (FR-123)', async () => {
      await expect(
        launch({ overrides: { [LOCKED_FIELD_A]: 'c7i.24xlarge' } }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    })

    it('refuses a disabled profile, naming the reason to a caller who holds it', async () => {
      await db
        .update(executionProfiles)
        .set({ enabled: false })
        .where(eq(executionProfiles.id, ids.a.executionProfileId))

      try {
        await expect(launch()).rejects.toMatchObject({ code: 'CONFLICT' })
      } finally {
        await db
          .update(executionProfiles)
          .set({ enabled: true })
          .where(eq(executionProfiles.id, ids.a.executionProfileId))
      }
    })
  })

  describe('resuming a stored session (FR-016, US3)', () => {
    const seedSnapshot = async (options: {
      readonly workflowId: string
      readonly expiresAt: Date
      readonly complete?: boolean
    }): Promise<string> => {
      const sessionId = randomUUID()
      await db.insert(sessionSnapshots).values({
        workflowId: options.workflowId,
        sessionId,
        s3Key: `snapshots/${sessionId}.tar.zst`,
        sizeBytes: 1024,
        boundary: 'pause',
        hasConversationState: options.complete ?? true,
        hasWorktreeState: options.complete ?? true,
        expiresAt: options.expiresAt,
      })
      return sessionId
    }

    it('records the snapshot’s run as the predecessor, so consumption stays summable (FR-152)', async () => {
      const sessionId = await seedSnapshot({
        workflowId: ids.a.workflowId,
        expiresAt: new Date(Date.now() + 60_000),
      })

      const started = await launch({ resumeFromSessionId: sessionId })

      expect(started.workflow.predecessorWorkflowId).toBe(ids.a.workflowId)
      // The successor gets its own session id; conflating the two makes `--resume` find nothing.
      expect(started.workflow.sessionId).not.toBe(sessionId)
    })

    it('refuses an expired snapshot, stating the retention limit', async () => {
      const expiresAt = new Date(Date.now() - 60_000)
      const sessionId = await seedSnapshot({ workflowId: ids.a.workflowId, expiresAt })

      await expect(launch({ resumeFromSessionId: sessionId })).rejects.toMatchObject({
        code: 'CONFLICT',
      })
    })

    it('refuses an incomplete snapshot rather than restoring an unusable one (FR-050)', async () => {
      const sessionId = await seedSnapshot({
        workflowId: ids.a.workflowId,
        expiresAt: new Date(Date.now() + 60_000),
        complete: false,
      })

      await expect(launch({ resumeFromSessionId: sessionId })).rejects.toMatchObject({
        code: 'CONFLICT',
      })
    })

    it('hides a snapshot belonging to a run the caller cannot see, and says so as NOT_FOUND', async () => {
      // Scope is checked before expiry, so "that session expired" is never said about a run whose
      // existence the caller was not entitled to learn.
      const sessionId = await seedSnapshot({
        workflowId: ids.b.workflowId,
        expiresAt: new Date(Date.now() - 60_000),
      })

      const refusals: { code?: string; message?: string }[] = []
      for (const candidate of [sessionId, randomUUID()]) {
        try {
          await launch({ resumeFromSessionId: candidate })
        } catch (caught) {
          refusals.push(caught as { code?: string; message?: string })
        }
      }

      expect(refusals[0]?.code).toBe('NOT_FOUND')
      expect(refusals[0]?.message).toBe(refusals[1]?.message)
    })
  })

  /**
   * FR-120 on the launch path — **the guard, not the module that implements it.**
   *
   * `branch-lock.test.ts` proves that `withBranchLocks` serialises and refuses. What is at stake
   * here is whether `startWorkflow` *takes* it, and the two are not the same claim: for most of
   * this feature's life the lock existed, was tested, and nothing called it.
   *
   * The interesting assertion is therefore the racing one. A suite that only checked "the second
   * launch was refused" would pass just as happily against a `select` followed by an `insert` —
   * which is the implementation the lock exists to rule out — so the test below holds one
   * launcher's transaction open, waits for Postgres itself to report a backend parked on an
   * advisory lock, and only then believes that the second one is blocked rather than merely slow.
   */
  describe('the branch guard (FR-120)', () => {
    it('refuses a launch onto a branch a running workflow holds, naming the holder', async () => {
      await db.update(workflows).set({ state: 'running' }).where(eq(workflows.id, ids.a.workflowId))

      const refusal = await refusalOf(async () => launch())

      expect(refusal.code).toBe('CONFLICT')
      expect(refusal.message).toContain(ids.a.workflowId)
      expect(refusal.message).toContain(ids.a.repositoryUrl)
    })

    it('writes nothing on the way to that refusal', async () => {
      await db.update(workflows).set({ state: 'running' }).where(eq(workflows.id, ids.a.workflowId))

      const before = await db.select({ id: workflows.id }).from(workflows)
      await refusalOf(async () => launch())
      const after = await db.select({ id: workflows.id }).from(workflows)

      expect(after).toHaveLength(before.length)
    })

    it('refuses a second launch while the first is still queued on the same branch', async () => {
      const first = await launch()
      const refusal = await refusalOf(async () => launch())

      expect(refusal.code).toBe('CONFLICT')
      expect(refusal.message).toContain(first.workflow.id)
    })

    it('makes a concurrent launcher block on the lock rather than race it', async () => {
      // The winner holds the advisory lock for the workspace's branch and stays in its
      // transaction. `startWorkflow` cannot be paused mid-flight, so the winner is the lock taken
      // by hand — the same key `startWorkflow` computes, from the same pairs.
      const pairs = await readWorkspaceBranchPairs(db, ids.a.workspaceVersionId)
      expect(pairs).not.toHaveLength(0)

      const held = createGate()
      const release = createGate()

      const winner = db.transaction(async (tx) => {
        await acquireBranchLocks(tx, pairs)
        held.open()
        await release.opened
        return 'winner'
      })

      await held.opened

      let launchSettled = false
      const launched = launch().finally(() => {
        launchSettled = true
      })

      // Without this, a run in which the launch simply executed after the winner would look
      // identical to one in which the lock made it wait, and only the second proves anything.
      let blocked = 0
      for (let attempt = 0; attempt < 200 && blocked === 0; attempt += 1) {
        await sleep(25)
        blocked = await waitingOnAdvisoryLocks()
      }

      expect(blocked).toBeGreaterThan(0)
      expect(launchSettled).toBe(false)

      release.open()
      await expect(winner).resolves.toBe('winner')
      await expect(launched).resolves.toMatchObject({ workflow: { state: 'queued' } })
    }, 30_000)

    it('reads state committed by the launcher it waited for, not state from before it', async () => {
      // The check-then-write this replaces, put under a microscope: the loser's holder probe would
      // have run before the winner committed and found nothing, and two runs would have gone onto
      // one branch. Under the lock the probe runs after the winner commits, so it sees the row.
      const pairs = await readWorkspaceBranchPairs(db, ids.a.workspaceVersionId)
      const written = createGate()
      const release = createGate()

      const winner = db.transaction(async (tx) => {
        await acquireBranchLocks(tx, pairs)

        const inserted = await tx
          .insert(workflows)
          .values({
            type: 'delegated',
            state: 'queued',
            ownerUserId: ids.alice,
            setupBundleVersionId: ids.bundleVersion,
            workspaceVersionId: ids.a.workspaceVersionId,
            model: 'claude-opus-5',
            instanceType: 'm7i.large',
            purchaseMode: 'spot',
            sessionId: randomUUID(),
          })
          .returning({ id: workflows.id })

        const workflowId = inserted[0]?.id ?? ''
        await tx.insert(workflowEntries).values(
          pairs.map((entry) => ({
            workflowId,
            workspaceEntryId: ids.a.workspaceEntryId,
            repositoryUrl: entry.repositoryUrl,
            baseBranch: entry.baseBranch,
            subdirectory: 'a',
          })),
        )

        written.open()
        await release.opened
        return workflowId
      })

      await written.opened

      const loser = refusalOf(async () => launch())

      await sleep(200)
      release.open()

      const winnerId = await winner
      expect((await loser).message).toContain(winnerId)
    }, 30_000)
  })
})
