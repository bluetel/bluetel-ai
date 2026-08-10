import { computeLeases, workflowEvents, workflows } from '@bluetel-ai/sisyphus-api/db'
import { and, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createCredentialPoolFixtures, createGate } from '../credentials/allocate/pool-fixtures'
import { releaseLease } from '../credentials/lease'

import type { AdmittedWorkflow, WorkflowStarter } from './admit-workflow'
import { admitWorkflow } from './admit-workflow'
import { drainQueue, runDrainQueue } from './drain-queue'
import { createWorkflowFixtures, readTestDatabaseUrl } from './workflow-fixtures'

/**
 * The drain exists so the ceiling does not build a queue nothing empties, so these tests are about
 * the queue actually emptying — in admission order, and without a concurrent drain admitting
 * anything twice.
 */

const connectionString = readTestDatabaseUrl()
const describeWithDatabase = connectionString === undefined ? describe.skip : describe

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

/** Recording stand-in for `start-workflow.ts` (T052), which does not exist yet. */
const createRecordingStarter = (
  onStart?: (input: AdmittedWorkflow) => Promise<void>,
): WorkflowStarter & { readonly started: readonly string[] } => {
  const started: string[] = []
  return {
    started,
    start: async (input) => {
      started.push(input.workflowId)
      await onStart?.(input)
    },
  }
}

describeWithDatabase('the queue drain against a live database', () => {
  const fixtures = createWorkflowFixtures(connectionString ?? '')

  beforeAll(() => fixtures.open(), 60_000)
  afterEach(() => fixtures.removeAll())
  afterAll(() => fixtures.close())

  /** Three queued workflows, oldest first, created a minute apart so order is data not timing. */
  const seedQueue = async (): Promise<readonly string[]> => {
    const first = await fixtures.seedWorkflow({
      label: 'first',
      createdAt: new Date('2026-08-05T09:00:00.000Z'),
    })
    const second = await fixtures.seedWorkflow({
      label: 'second',
      createdAt: new Date('2026-08-05T09:01:00.000Z'),
    })
    const third = await fixtures.seedWorkflow({
      label: 'third',
      createdAt: new Date('2026-08-05T09:02:00.000Z'),
    })
    return [first, second, third]
  }

  it('empties the queue in admission order when the ceiling allows', async () => {
    const queue = await seedQueue()

    const result = await drainQueue({ db: fixtures.db(), ceiling: 5 })

    expect(result.admitted.map((admission) => admission.workflowId)).toEqual([...queue])
    expect(result.remainingQueued).toBe(0)
    expect(result.ceilingReached).toBe(false)
    expect(await fixtures.countLiveLeases()).toBe(3)
  })

  it('stops at the ceiling and leaves the rest queued, oldest admitted first', async () => {
    const [first, second, third] = await seedQueue()

    const result = await drainQueue({ db: fixtures.db(), ceiling: 2 })

    expect(result.admitted.map((admission) => admission.workflowId)).toEqual([first, second])
    expect(result.ceilingReached).toBe(true)
    expect(result.remainingQueued).toBe(1)
    expect(await fixtures.stateOf(third)).toBe('queued')
  })

  it('does nothing at all when the ceiling is already full', async () => {
    const holder = await fixtures.seedWorkflow({ label: 'holder', state: 'provisioning' })
    await fixtures.seedLease(holder)
    const waiting = await fixtures.seedWorkflow({ label: 'waiting' })

    const result = await drainQueue({ db: fixtures.db(), ceiling: 1 })

    expect(result).toMatchObject({ admitted: [], ceilingReached: true, remainingQueued: 1 })
    expect(await fixtures.countLeasesFor(waiting)).toBe(0)
  })

  it('re-admits when a lease releases — the queue empties over successive drains', async () => {
    const [first, second] = await seedQueue()

    const firstDrain = await drainQueue({ db: fixtures.db(), ceiling: 1 })
    expect(firstDrain.admitted.map((admission) => admission.workflowId)).toEqual([first])

    // Nothing has changed, so a second drain admits nothing — the ceiling is still full.
    expect((await drainQueue({ db: fixtures.db(), ceiling: 1 })).admitted).toEqual([])

    const leaseId = firstDrain.admitted[0]?.leaseId ?? ''
    await fixtures.releaseLease(leaseId)

    // Teardown (T066) calls the drain after releasing; this is that call.
    const afterRelease = await drainQueue({ db: fixtures.db(), ceiling: 1 })
    expect(afterRelease.admitted.map((admission) => admission.workflowId)).toEqual([second])
    expect(afterRelease.remainingQueued).toBe(1)
  })

  it('honours a limit so one invocation cannot run unboundedly', async () => {
    await seedQueue()

    const result = await drainQueue({ db: fixtures.db(), ceiling: 10, limit: 2 })

    expect(result.admitted).toHaveLength(2)
    expect(result.remainingQueued).toBe(1)
    // Stopped on the limit, not on the ceiling — the difference matters to whoever reads this.
    expect(result.ceilingReached).toBe(false)
  })

  it('hands each admitted workflow to provisioning, in order', async () => {
    const queue = await seedQueue()
    const starter = createRecordingStarter()

    await drainQueue({ db: fixtures.db(), ceiling: 5, starter })

    expect(starter.started).toEqual([...queue])
  })

  it('records a provisioning failure and keeps draining, leaving the lease for the reconciler', async () => {
    const [first, second, third] = await seedQueue()
    const starter = createRecordingStarter((input) =>
      input.workflowId === first
        ? Promise.reject(new Error('InsufficientInstanceCapacity'))
        : Promise.resolve(),
    )

    const result = await drainQueue({ db: fixtures.db(), ceiling: 5, starter })

    expect(result.startFailures).toMatchObject([{ workflowId: first }])
    expect(result.startFailures[0]?.error.message).toBe('InsufficientInstanceCapacity')
    expect(starter.started).toEqual([first, second, third])
    // The workflow stays admitted with its lease: an FR-039 sweep releases it, and losing the
    // failure here would leave a lease nobody knows about.
    expect(await fixtures.stateOf(first)).toBe('provisioning')
    expect(await fixtures.countLiveLeases()).toBe(3)
  })

  it('does not count a workflow admitted by someone else mid-drain', async () => {
    const [first, second, third] = await seedQueue()

    // The interleave, made deterministic: while the drain is handing `first` to provisioning,
    // something else admits `second` — exactly the window a concurrent drain occupies. `second` is
    // already on this drain's candidate list, so the drain will reach it and find it leased.
    const starter = createRecordingStarter(async (input) => {
      if (input.workflowId === first) {
        await admitWorkflow({ db: fixtures.db(), workflowId: second, ceiling: 5 })
      }
    })

    const result = await drainQueue({ db: fixtures.db(), ceiling: 5, starter })

    // `second` was admitted — but not by this drain, so it is not in `admitted` and was never
    // handed to provisioning. Counting a coalesce is how a drain double-starts a workflow.
    expect(result.admitted.map((admission) => admission.workflowId)).toEqual([first, third])
    expect(starter.started).toEqual([first, third])
    expect(await fixtures.countLeasesFor(second)).toBe(1)
    expect(await fixtures.countLiveLeases()).toBe(3)
  })

  it('does not double-admit when two drains race (FR-078)', async () => {
    const queue = await seedQueue()
    const firstStarter = createRecordingStarter()
    const secondStarter = createRecordingStarter()

    const [left, right] = await Promise.all([
      drainQueue({ db: fixtures.db(), ceiling: 5, starter: firstStarter }),
      drainQueue({ db: fixtures.db(), ceiling: 5, starter: secondStarter }),
    ])

    const admitted = [...left.admitted, ...right.admitted].map((admission) => admission.workflowId)
    // Every workflow admitted exactly once, across both drains — the loser of each contest saw a
    // `coalesced` outcome, which the drain does not count.
    expect([...admitted].sort()).toEqual([...queue].sort())
    expect(new Set(admitted).size).toBe(3)
    expect(await fixtures.countLiveLeases()).toBe(3)

    for (const workflowId of queue) {
      expect(await fixtures.countLeasesFor(workflowId)).toBe(1)
    }
    // And nothing was handed to provisioning twice, which is what a double-admit would have cost.
    expect([...firstStarter.started, ...secondStarter.started].sort()).toEqual([...queue].sort())
  }, 30_000)

  it('races two drains against a ceiling of one and admits exactly one workflow', async () => {
    await seedQueue()

    const [left, right] = await Promise.all([
      drainQueue({ db: fixtures.db(), ceiling: 1 }),
      drainQueue({ db: fixtures.db(), ceiling: 1 }),
    ])

    expect(left.admitted.length + right.admitted.length).toBe(1)
    expect(await fixtures.countLiveLeases()).toBe(1)
  }, 30_000)

  it('reports through the uniform job envelope', async () => {
    await seedQueue()

    const outcome = await runDrainQueue({ db: fixtures.db(), ceiling: 5 })

    expect(outcome.ok).toBe(true)
    expect(outcome.ok ? outcome.value.admitted : []).toHaveLength(3)
    expect(outcome.jobName).toBe('drain-queue')
  })
})

/**
 * **Granting a freed seat, and refusing to let one exhausted group stall the platform** (T065–T067).
 *
 * A separate scope with its own scratch database, because these tests need the graph
 * `workflow-fixtures.ts` cannot seed — an execution profile with ordered credential-group
 * attachments, credentials in chosen states, and workflows pinned to that profile.
 * `createCredentialPoolFixtures` is that seeder, and reusing it is the point.
 *
 * The test that earns its place here is the SC-017 one. Everything else observes an ordering that a
 * simpler implementation could also produce; that one observes what happens to a run the drain
 * **cannot** serve, and a drain that treated "still waiting" as "the queue is blocked" fails it
 * while passing every other test in this file.
 */
describeWithDatabase('granting seats to waiting runs', () => {
  const pool = createCredentialPoolFixtures(connectionString ?? '')

  beforeAll(() => pool.open(), 120_000)
  afterAll(() => pool.close(), 120_000)

  /**
   * The compute side is this directory's and has to be cleared between tests; `clearLeases`
   * returns the credential pool to its seeded state. Without both, the FR-040 ceiling counts leases
   * an earlier test left behind and admissions start refusing for reasons nothing here is about.
   */
  afterEach(async () => {
    await pool.db().delete(workflowEvents)
    await pool.db().delete(computeLeases)
    await pool.clearLeases()
    await pool.db().delete(workflows)
  })

  const computeLeasesFor = async (workflowId: string): Promise<number> =>
    (
      await pool
        .db()
        .select({ id: computeLeases.id })
        .from(computeLeases)
        .where(eq(computeLeases.workflowId, workflowId))
    ).length

  const stateOf = async (workflowId: string): Promise<string | undefined> =>
    (
      await pool
        .db()
        .select({ state: workflows.state })
        .from(workflows)
        .where(eq(workflows.id, workflowId))
    )[0]?.state

  /** A group holding `size` free credentials, and a profile attached to it. */
  const seedPool = async (label: string, size: number): Promise<string> => {
    const credentialGroupId = await pool.seedGroup({ label: `${label}-group` })

    for (let index = 0; index < size; index += 1) {
      await pool.seedCredential({ label: `${label}-${String(index)}`, credentialGroupId })
    }

    return pool.seedProfile({
      label: `${label}-profile`,
      groups: [{ credentialGroupId, position: 1 }],
    })
  }

  it('does not let one saturated group stall a profile attached elsewhere (SC-017)', async () => {
    // Two pools that share nothing. `alpha` is full; `beta` has a seat going spare. The run under
    // `alpha` is **older**, so it is examined first, and a drain that stopped at the first candidate
    // it could not serve would leave `beta`'s run queued behind a group it has no relationship with
    // — for exactly as long as somebody else's pool stayed saturated.
    const alphaGroup = await pool.seedGroup({ label: 'sc017-alpha' })
    await pool.seedCredential({
      label: 'sc017-alpha-taken',
      credentialGroupId: alphaGroup,
      state: 'held',
    })
    const alphaProfile = await pool.seedProfile({
      label: 'sc017-alpha-profile',
      groups: [{ credentialGroupId: alphaGroup, position: 1 }],
    })
    const betaProfile = await seedPool('sc017-beta', 1)

    const blocked = await pool.seedWorkflow({
      label: 'sc017-blocked',
      executionProfileId: alphaProfile,
    })
    const unrelated = await pool.seedWorkflow({
      label: 'sc017-unrelated',
      executionProfileId: betaProfile,
    })

    const result = await drainQueue({ db: pool.db(), ceiling: 5 })

    expect(result.admitted.map((admission) => admission.workflowId)).toEqual([unrelated])
    expect(result.waiting.map((waiter) => waiter.workflowId)).toEqual([blocked])
    expect(await stateOf(blocked)).toBe('awaiting_credential')
    expect(await stateOf(unrelated)).toBe('provisioning')
    // And the run that could not be served cost nothing while it waited (SC-004).
    expect(await computeLeasesFor(blocked)).toBe(0)
  }, 60_000)

  it('grants a released seat to the longest-waiting run that can reach it (FR-026)', async () => {
    const executionProfileId = await seedPool('order', 1)
    const first = await pool.seedWorkflow({ label: 'order-first', executionProfileId })
    const second = await pool.seedWorkflow({ label: 'order-second', executionProfileId })
    const third = await pool.seedWorkflow({ label: 'order-third', executionProfileId })

    const opening = await drainQueue({ db: pool.db(), ceiling: 5 })
    expect(opening.admitted.map((admission) => admission.workflowId)).toEqual([first])
    expect(opening.waiting.map((waiter) => waiter.workflowId)).toEqual([second, third])

    // Nothing has changed, so a second drain grants nothing — the one seat is still out.
    expect((await drainQueue({ db: pool.db(), ceiling: 5 })).admitted).toEqual([])

    // Teardown releases the seat when the run ends, and then drains; this is that pair.
    await releaseLease({ db: pool.db(), workflowId: first, reason: 'terminal' })
    const afterRelease = await drainQueue({ db: pool.db(), ceiling: 5 })

    // One seat, one grant, to the older of the two waiters (FR-026: one workflow per release).
    expect(afterRelease.admitted.map((admission) => admission.workflowId)).toEqual([second])
    expect(afterRelease.waiting.map((waiter) => waiter.workflowId)).toEqual([third])
    expect(await pool.liveLeases()).toHaveLength(1)
    expect(await stateOf(third)).toBe('awaiting_credential')
  }, 60_000)

  it('reports the wait from when it began, not from when the drain looked (SC-006)', async () => {
    const executionProfileId = await seedPool('clock', 1)
    await pool.seedWorkflow({ label: 'clock-holder', executionProfileId })
    const waiter = await pool.seedWorkflow({ label: 'clock-waiter', executionProfileId })

    const first = await drainQueue({ db: pool.db(), ceiling: 5 })
    const second = await drainQueue({ db: pool.db(), ceiling: 5 })

    const began = first.waiting.find((entry) => entry.workflowId === waiter)?.since
    const later = second.waiting.find((entry) => entry.workflowId === waiter)?.since

    expect(began).toBeDefined()
    // A clock restarted on every pass is a limit that never fires and a panel that says an
    // hour-old wait is four seconds old.
    expect(later).toStrictEqual(began)
  }, 60_000)

  it('hands a seat back rather than losing it to a run cancelled in the same moment (T066)', async () => {
    // The race, made deterministic. A gate transaction holds the workflow row `for update`, so
    // admission gets as far as reserving the seat and then parks on the lock — the exact window a
    // `stop` can land in. The gate cancels the run and commits; admission wakes, re-reads the state
    // under the lock, and finds a run that is not going to start.
    const executionProfileId = await seedPool('cancel-race', 1)
    const workflowId = await pool.seedWorkflow({ label: 'cancel-race-run', executionProfileId })

    const locked = createGate()
    const release = createGate()

    const gate = pool.db().transaction(async (tx) => {
      await tx
        .select({ id: workflows.id })
        .from(workflows)
        .where(eq(workflows.id, workflowId))
        .for('update')
      locked.open()
      await release.opened
      await tx
        .update(workflows)
        .set({ state: 'cancelled', terminalOutcome: 'cancelled' })
        .where(eq(workflows.id, workflowId))
    })

    await locked.opened

    let settled = false
    const draining = drainQueue({ db: pool.db(), ceiling: 5 }).finally(() => {
      settled = true
    })

    let blocked = 0
    for (let attempt = 0; attempt < 200 && blocked === 0; attempt += 1) {
      await sleep(25)
      blocked = await pool.backendsWaitingOnLocks()
    }
    expect(blocked).toBeGreaterThan(0)
    expect(settled).toBe(false)

    release.open()
    await gate

    const result = await draining

    // Neither admitted nor left waiting: the run is gone.
    expect(result.admitted).toEqual([])
    expect(result.waiting).toEqual([])
    // **Not lost.** The seat this admission took for a run that will never boot is back in the
    // pool, rather than stranded until the FR-022 sweep noticed a reconciliation interval later.
    expect(await pool.liveLeases()).toHaveLength(0)
    const [credential] = await pool.leases()
    expect(await pool.credential(credential.agentCredentialId)).toMatchObject({
      state: 'available',
    })
    expect(await computeLeasesFor(workflowId)).toBe(0)
  }, 60_000)

  it('never grants one seat twice, however many drains are sweeping (T066)', async () => {
    // One free seat, two runs that both want it, two drains racing. The conditional update and
    // `credential_leases_live_key` are what decide it, and the loser must report its run as still
    // waiting rather than as holding a credential somebody else has.
    const executionProfileId = await seedPool('double-grant', 1)
    const first = await pool.seedWorkflow({ label: 'double-first', executionProfileId })
    const second = await pool.seedWorkflow({ label: 'double-second', executionProfileId })

    const [left, right] = await Promise.all([
      drainQueue({ db: pool.db(), ceiling: 5 }),
      drainQueue({ db: pool.db(), ceiling: 5 }),
    ])

    const admitted = [...left.admitted, ...right.admitted].map((entry) => entry.workflowId)

    expect(admitted).toHaveLength(1)
    expect(await pool.liveLeases()).toHaveLength(1)

    const other = admitted[0] === first ? second : first
    expect(await stateOf(other)).toBe('awaiting_credential')
    expect(await computeLeasesFor(other)).toBe(0)
  }, 60_000)

  it('fails a run that waits past the limit, naming exhaustion and the duration (FR-028)', async () => {
    const executionProfileId = await seedPool('expiry', 1)
    await pool.seedWorkflow({ label: 'expiry-holder', executionProfileId })
    const waiter = await pool.seedWorkflow({ label: 'expiry-waiter', executionProfileId })

    await drainQueue({ db: pool.db(), ceiling: 5 })
    expect(await stateOf(waiter)).toBe('awaiting_credential')

    const announced: { workflowId: string; event: string }[] = []
    const result = await drainQueue({
      db: pool.db(),
      ceiling: 5,
      credentialWaitLimitMs: 60_000,
      // The clock, injected: a limit that had to be waited out is a test nobody runs.
      now: () => new Date(Date.now() + 5 * 60_000),
      notifier: {
        workflowEvent: (notice) => {
          announced.push({ workflowId: notice.workflowId, event: notice.event })
          return Promise.resolve({ outcome: 'sent' } as never)
        },
        integrationTick: () => Promise.resolve([] as never),
      },
    })

    expect(result.expired.map((entry) => entry.workflowId)).toEqual([waiter])
    expect(result.expired[0]?.waitedMs).toBeGreaterThan(60_000)
    expect(result.expired[0]?.reason.kind).toBe('all_held')

    const [row] = await pool
      .db()
      .select({
        state: workflows.state,
        terminalOutcome: workflows.terminalOutcome,
        outcomeReason: workflows.outcomeReason,
      })
      .from(workflows)
      .where(eq(workflows.id, waiter))

    expect(row.state).toBe('failed')
    expect(row.terminalOutcome).toBe('failed')
    // Named, and timed: "failed: no credential" tells an operator nothing about whether the pool is
    // one seat short or entirely broken.
    expect(row.outcomeReason).toMatch(/credential exhaustion/)
    expect(row.outcomeReason).toMatch(/waited \d+s/)

    const [event] = await pool
      .db()
      .select({ event: workflowEvents.event, detail: workflowEvents.detail })
      .from(workflowEvents)
      .where(and(eq(workflowEvents.workflowId, waiter), eq(workflowEvents.event, 'failed')))

    // The duration as a number as well as in the sentence — a figure only available inside English
    // is a figure nothing can aggregate.
    expect(event.detail).toMatchObject({ credentialWaitReason: 'all_held', waitLimitMs: 60_000 })
    expect((event.detail as { waitedMs: number }).waitedMs).toBeGreaterThan(60_000)

    // It held no compute and no seat, so there was nothing to release (FR-025).
    expect(await computeLeasesFor(waiter)).toBe(0)
    expect(await pool.liveLeases()).toHaveLength(1)

    // A failure *is* notifiable (FR-136) — unlike the wait itself, which FR-079 keeps silent.
    expect(announced).toEqual([{ workflowId: waiter, event: 'workflow_failed' }])
  }, 60_000)

  it('leaves a wait inside the limit alone', async () => {
    const executionProfileId = await seedPool('inside', 1)
    await pool.seedWorkflow({ label: 'inside-holder', executionProfileId })
    const waiter = await pool.seedWorkflow({ label: 'inside-waiter', executionProfileId })

    await drainQueue({ db: pool.db(), ceiling: 5 })
    const result = await drainQueue({ db: pool.db(), ceiling: 5, credentialWaitLimitMs: 60_000 })

    expect(result.expired).toEqual([])
    expect(result.remainingAwaitingCredential).toBe(1)
    expect(await stateOf(waiter)).toBe('awaiting_credential')
  }, 60_000)
})
