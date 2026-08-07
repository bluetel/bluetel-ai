import {
  computeLeases,
  createDatabaseClient,
  workflowEvents,
  workflows,
} from '@bluetel-ai/sisyphus-api/db'
import { eq, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  ADMISSION_LOCK_CLASS,
  ADMISSION_LOCK_KEY,
  admitWorkflow,
  countLiveLeases,
  runAdmitWorkflow,
} from './admit-workflow'
import { createWorkflowFixtures, readTestDatabaseUrl } from './workflow-fixtures'

/**
 * FR-040 is not a rule about a number; it is a rule about an *interleaving*. A test that calls
 * admission twice in sequence passes against a check-then-write implementation that would let two
 * simultaneous admissions both take the last slot — so the last two tests here actually interleave
 * two transactions, and the first of them asserts that the loser **blocked** rather than merely
 * that it lost. Removing the advisory lock from `admitWorkflow` makes both of them fail: with the
 * lock taken out, the choreographed loser never parks (`backendsWaitingOnLocks` stays at zero) and
 * the pair fired together both admit, leaving two leases under a ceiling of one.
 */

const connectionString = readTestDatabaseUrl()
const describeWithDatabase = connectionString === undefined ? describe.skip : describe

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

describe('the admission contract', () => {
  it('refuses a ceiling that is not a positive integer before touching the database', async () => {
    // The pool is lazy — no connection is opened unless a query is issued, and the guard rejects
    // before the transaction starts. So this runs on a machine with no Postgres.
    const client = createDatabaseClient({
      connectionString: 'postgres://unused:unused@localhost:1/unused',
    })

    try {
      for (const ceiling of [0, -1, 1.5, Number.NaN]) {
        await expect(
          admitWorkflow({ db: client.db, workflowId: crypto.randomUUID(), ceiling }),
        ).rejects.toThrow(/positive integer/)
      }
    } finally {
      await client.close()
    }
  })
})

describeWithDatabase('admission against a live database', () => {
  const fixtures = createWorkflowFixtures(connectionString ?? '')

  beforeAll(() => fixtures.open(), 60_000)
  afterEach(() => fixtures.removeAll())
  afterAll(() => fixtures.close())

  it('admits a queued workflow, takes its lease and records the transition', async () => {
    const workflowId = await fixtures.seedWorkflow({ label: 'first' })

    const outcome = await admitWorkflow({ db: fixtures.db(), workflowId, ceiling: 2 })

    expect(outcome).toMatchObject({
      outcome: 'admitted',
      workflowId,
      queuePosition: 0,
      liveLeases: 1,
      ceiling: 2,
      instanceType: 'fixture.small',
      purchaseMode: 'spot',
    })
    expect(await fixtures.stateOf(workflowId)).toBe('provisioning')
    expect(await fixtures.countLiveLeases()).toBe(1)

    const events = await fixtures
      .db()
      .select({ event: workflowEvents.event, actorType: workflowEvents.actorType })
      .from(workflowEvents)
      .where(eq(workflowEvents.workflowId, workflowId))
    expect(events).toEqual([{ event: 'admitted', actorType: 'control_plane' }])
  })

  it('takes the lease with no instance yet — capacity is committed at admission, not at launch', async () => {
    const workflowId = await fixtures.seedWorkflow({ label: 'lease-shape' })

    await admitWorkflow({ db: fixtures.db(), workflowId, ceiling: 1 })

    const [lease] = await fixtures
      .db()
      .select()
      .from(computeLeases)
      .where(eq(computeLeases.workflowId, workflowId))
    expect(lease).toMatchObject({
      providerInstanceId: null,
      releasedAt: null,
      instanceType: 'fixture.small',
      purchaseMode: 'spot',
    })
  })

  it('counts leases rather than workflow rows: queued work costs nothing (FR-040)', async () => {
    // Five queued workflows and no leases at all. Counting rows would refuse at a ceiling of two;
    // counting leases admits, because none of these five is holding anything.
    for (const label of ['a', 'b', 'c', 'd']) {
      await fixtures.seedWorkflow({ label })
    }
    const workflowId = await fixtures.seedWorkflow({ label: 'e' })

    await expect(
      admitWorkflow({ db: fixtures.db(), workflowId, ceiling: 2 }),
    ).resolves.toMatchObject({ outcome: 'admitted' })
  })

  it('counts a lease whose workflow is already terminal: winding down still costs (FR-040)', async () => {
    // The instance is still being torn down, so the lease is unreleased even though the run is
    // over. Counting workflow states would call this slot free and overshoot the ceiling.
    const finished = await fixtures.seedWorkflow({ label: 'winding-down', state: 'succeeded' })
    await fixtures.seedLease(finished)
    const waiting = await fixtures.seedWorkflow({ label: 'waiting' })

    const outcome = await admitWorkflow({ db: fixtures.db(), workflowId: waiting, ceiling: 1 })

    expect(outcome).toMatchObject({
      outcome: 'queued',
      queuePosition: 1,
      liveLeases: 1,
      ceiling: 1,
    })
    expect(await fixtures.stateOf(waiting)).toBe('queued')
    expect(await fixtures.countLeasesFor(waiting)).toBe(0)
  })

  it('re-admits once the lease is released — the ceiling is a moment, not a verdict', async () => {
    const running = await fixtures.seedWorkflow({ label: 'running', state: 'provisioning' })
    const leaseId = await fixtures.seedLease(running)
    const waiting = await fixtures.seedWorkflow({ label: 'waiting' })

    await expect(
      admitWorkflow({ db: fixtures.db(), workflowId: waiting, ceiling: 1 }),
    ).resolves.toMatchObject({ outcome: 'queued' })

    await fixtures.releaseLease(leaseId)

    await expect(
      admitWorkflow({ db: fixtures.db(), workflowId: waiting, ceiling: 1 }),
    ).resolves.toMatchObject({ outcome: 'admitted' })
  })

  it('reports queue position oldest first, so a wait is legible', async () => {
    const held = await fixtures.seedWorkflow({ label: 'holder', state: 'provisioning' })
    await fixtures.seedLease(held)

    const first = await fixtures.seedWorkflow({
      label: 'queued-first',
      createdAt: new Date('2026-08-05T09:00:00.000Z'),
    })
    const second = await fixtures.seedWorkflow({
      label: 'queued-second',
      createdAt: new Date('2026-08-05T09:01:00.000Z'),
    })
    const third = await fixtures.seedWorkflow({
      label: 'queued-third',
      createdAt: new Date('2026-08-05T09:02:00.000Z'),
    })

    const positions = []
    for (const workflowId of [third, first, second]) {
      const outcome = await admitWorkflow({ db: fixtures.db(), workflowId, ceiling: 1 })
      positions.push(outcome.outcome === 'queued' ? outcome.queuePosition : -1)
    }

    // Asked about in the order third, first, second — answered 3, 1, 2.
    expect(positions).toEqual([3, 1, 2])
  })

  it('coalesces a duplicate start into the existing lease rather than failing it (FR-078)', async () => {
    const workflowId = await fixtures.seedWorkflow({ label: 'double-clicked' })

    const first = await admitWorkflow({ db: fixtures.db(), workflowId, ceiling: 4 })
    const second = await admitWorkflow({ db: fixtures.db(), workflowId, ceiling: 4 })

    expect(first.outcome).toBe('admitted')
    expect(second).toMatchObject({
      outcome: 'coalesced',
      workflowId,
      leaseId: first.outcome === 'admitted' ? first.leaseId : undefined,
      state: 'provisioning',
    })
    expect(await fixtures.countLeasesFor(workflowId)).toBe(1)
    expect(await fixtures.countLiveLeases()).toBe(1)
  })

  it('refuses a workflow that is not queued, naming the state it found', async () => {
    const workflowId = await fixtures.seedWorkflow({ label: 'cancelled', state: 'cancelled' })

    await expect(admitWorkflow({ db: fixtures.db(), workflowId, ceiling: 4 })).resolves.toEqual({
      outcome: 'not_admissible',
      workflowId,
      state: 'cancelled',
    })
    expect(await fixtures.countLiveLeases()).toBe(0)
  })

  it('reports a missing workflow through the job envelope rather than throwing at the runner', async () => {
    const outcome = await runAdmitWorkflow({
      db: fixtures.db(),
      workflowId: crypto.randomUUID(),
      ceiling: 1,
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.ok ? undefined : outcome.error.message).toMatch(/does not exist/)
  })

  it('makes the second of two concurrent admissions block and then queue (FR-040)', async () => {
    // Ceiling of one, nothing leased yet, two workflows wanting the slot. Under a check-then-write
    // both would read zero live leases, both would decide there was room, and the platform would
    // run two instances under a ceiling of one.
    const winnerId = await fixtures.seedWorkflow({ label: 'race-winner' })
    const loserId = await fixtures.seedWorkflow({ label: 'race-loser' })
    expect(await fixtures.countLiveLeases()).toBe(0)

    const written = createGate()
    const release = createGate()

    // The winner: the same sequence `admitWorkflow` performs — advisory lock, count, insert — held
    // open after it has written, so its locks are still in place when the loser arrives.
    /* cspell:ignore xact */
    const winner = fixtures.db().transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(${ADMISSION_LOCK_CLASS}, ${ADMISSION_LOCK_KEY})`,
      )
      const before = await countLiveLeases(tx)
      await tx
        .insert(computeLeases)
        .values({ workflowId: winnerId, instanceType: 'fixture.small', purchaseMode: 'spot' })
      await tx.update(workflows).set({ state: 'provisioning' }).where(eq(workflows.id, winnerId))
      written.open()
      await release.opened
      return before
    })

    await written.opened

    let loserSettled = false
    const loser = admitWorkflow({ db: fixtures.db(), workflowId: loserId, ceiling: 1 }).finally(
      () => {
        loserSettled = true
      },
    )

    // Wait for Postgres to report a backend parked on a lock. Without this assertion a run in which
    // the loser simply happened to execute after the winner would look identical to one in which
    // the lock made it wait — and only the second proves anything.
    let blocked = 0
    for (let attempt = 0; attempt < 200 && blocked === 0; attempt += 1) {
      await sleep(25)
      blocked = await fixtures.backendsWaitingOnLocks()
    }
    expect(blocked).toBeGreaterThan(0)
    expect(loserSettled).toBe(false)

    release.open()
    await expect(winner).resolves.toBe(0)

    // The loser woke up on the *committed* lease, re-counted one, and queued. A count taken before
    // the transaction would still have said zero.
    await expect(loser).resolves.toMatchObject({
      outcome: 'queued',
      queuePosition: 1,
      liveLeases: 1,
    })
    expect(await fixtures.countLiveLeases()).toBe(1)
    expect(await fixtures.stateOf(loserId)).toBe('queued')
  }, 30_000)

  it('lets exactly one of two simultaneous admissions take the last slot (FR-040)', async () => {
    // The same race without the choreography: fire both and let the database decide. The outcome is
    // the requirement — one lease exists, under a ceiling of one.
    const firstId = await fixtures.seedWorkflow({ label: 'both-first' })
    const secondId = await fixtures.seedWorkflow({ label: 'both-second' })

    const outcomes = await Promise.all([
      admitWorkflow({ db: fixtures.db(), workflowId: firstId, ceiling: 1 }),
      admitWorkflow({ db: fixtures.db(), workflowId: secondId, ceiling: 1 }),
    ])

    expect(outcomes.filter((outcome) => outcome.outcome === 'admitted')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.outcome === 'queued')).toHaveLength(1)
    expect(await fixtures.countLiveLeases()).toBe(1)
  }, 30_000)
})
