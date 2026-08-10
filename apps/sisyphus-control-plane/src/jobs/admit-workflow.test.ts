import {
  computeLeases,
  createDatabaseClient,
  workflowEvents,
  workflows,
} from '@bluetel-ai/sisyphus-api/db'
import { eq, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createCredentialPoolFixtures } from '../credentials/allocate/pool-fixtures'
import { releaseLease } from '../credentials/lease'

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

/**
 * FR-016 — the seat, before the compute (T046).
 *
 * A separate scope with its own scratch database, because these tests need a graph
 * `workflow-fixtures.ts` cannot seed: an execution profile with ordered credential-group
 * attachments, credentials in chosen states, and workflows pinned to that profile.
 * `createCredentialPoolFixtures` is that seeder, and reusing it is the point — a fourth
 * scratch-database harness would be a fourth thing to keep in step.
 *
 * The test that earns its place is "claims the seat before it takes any compute lease". Everything
 * else here observes the *result* of an ordering, which a reversed implementation could still
 * produce; that one observes the world **between** the two writes, by parking admission on a table
 * lock the compute-lease insert needs and reading the database from outside while it waits. It is
 * the only assertion in the file that a credential-after-compute implementation cannot pass.
 */
describeWithDatabase('reserving an agent credential at admission (FR-016)', () => {
  const pool = createCredentialPoolFixtures(connectionString ?? '')

  beforeAll(() => pool.open(), 60_000)
  afterAll(() => pool.close())

  /**
   * `clearLeases` returns the credential pool to its seeded state; the compute side is this
   * directory's and has to be cleared here. Without it the FR-040 ceiling counts leases every
   * earlier test left behind, and admissions start reporting `queued` for reasons that have nothing
   * to do with what is under test.
   */
  afterEach(async () => {
    await pool.db().delete(workflowEvents)
    await pool.db().delete(computeLeases)
    await pool.clearLeases()
  })

  /** A pool of one group holding `size` credentials, and a profile attached to it. */
  const seedPool = async (label: string, size: number): Promise<string> => {
    const credentialGroupId = await pool.seedGroup({ label: `${label}-group` })

    for (let index = 0; index < size; index += 1) {
      await pool.seedCredential({ label: `${label}-cred-${String(index)}`, credentialGroupId })
    }

    return pool.seedProfile({
      label: `${label}-profile`,
      groups: [{ credentialGroupId, position: 1 }],
    })
  }

  const computeLeasesFor = async (workflowId: string): Promise<number> =>
    (
      await pool
        .db()
        .select({ id: computeLeases.id })
        .from(computeLeases)
        .where(eq(computeLeases.workflowId, workflowId))
    ).length

  it('claims a seat and names it on the admission, the workflow row and the timeline', async () => {
    const executionProfileId = await seedPool('reserve', 1)
    const workflowId = await pool.seedWorkflow({ label: 'reserve-run', executionProfileId })

    const outcome = await admitWorkflow({ db: pool.db(), workflowId, ceiling: 4 })

    expect(outcome).toMatchObject({ outcome: 'admitted', reservation: 'acquired' })

    const [lease] = await pool.liveLeases()
    expect(lease).toBeDefined()
    expect(outcome.outcome === 'admitted' ? outcome.agentCredential : undefined).toStrictEqual({
      credentialId: lease.agentCredentialId,
      leaseFence: lease.fence,
    })

    // FR-059: the run's own record names the identity it used, for the retention period.
    const [workflow] = await pool
      .db()
      .select({ agentCredentialId: workflows.agentCredentialId })
      .from(workflows)
      .where(eq(workflows.id, workflowId))
    expect(workflow.agentCredentialId).toBe(lease.agentCredentialId)

    // And on the timeline, so a run that started with a seat can be told from one that did not.
    const [admitted] = await pool
      .db()
      .select({ detail: workflowEvents.detail })
      .from(workflowEvents)
      .where(eq(workflowEvents.workflowId, workflowId))
    expect(admitted.detail).toMatchObject({
      agentCredentialId: lease.agentCredentialId,
      credentialReservation: 'acquired',
    })
  }, 30_000)

  it('claims the seat before it takes any compute lease (FR-016)', async () => {
    // The ordering proof. `compute_leases` is locked in EXCLUSIVE mode by a gate transaction, which
    // conflicts with the ROW EXCLUSIVE an INSERT needs but not with the ACCESS SHARE a SELECT takes.
    // So admission runs, reserves, and then parks on the compute-lease insert — and while it is
    // parked the database can be read from outside, at the one instant that distinguishes
    // "credential first" from "credential second".
    const executionProfileId = await seedPool('ordering', 1)
    const workflowId = await pool.seedWorkflow({ label: 'ordering-run', executionProfileId })

    const locked = createGate()
    const release = createGate()

    const gate = pool.db().transaction(async (tx) => {
      await tx.execute(sql`lock table compute_leases in exclusive mode`)
      locked.open()
      await release.opened
    })

    await locked.opened

    let admissionSettled = false
    const admission = admitWorkflow({ db: pool.db(), workflowId, ceiling: 4 }).finally(() => {
      admissionSettled = true
    })

    // Wait for Postgres to report the admitting backend parked. Without this the read below could
    // land after admission had finished, and would prove nothing about the order of its writes.
    let blocked = 0
    for (let attempt = 0; attempt < 200 && blocked === 0; attempt += 1) {
      await sleep(25)
      blocked = await pool.backendsWaitingOnLocks()
    }
    expect(blocked).toBeGreaterThan(0)
    expect(admissionSettled).toBe(false)

    // Mid-admission: the seat is claimed, committed and visible, and no compute lease exists.
    const held = await pool.liveLeases()
    expect(held).toHaveLength(1)
    expect(held[0].workflowId).toBe(workflowId)
    expect(await pool.credential(held[0].agentCredentialId)).toMatchObject({ state: 'held' })
    expect(await computeLeasesFor(workflowId)).toBe(0)

    release.open()
    await gate
    await expect(admission).resolves.toMatchObject({ outcome: 'admitted' })
    expect(await computeLeasesFor(workflowId)).toBe(1)
  }, 60_000)

  it('reserves nothing for a workflow the ceiling refuses, rather than churning the pool', async () => {
    // At the ceiling admission refuses constantly — every drain pass asks about every queued run —
    // and a reservation taken before that check would be acquired and handed straight back on each
    // one, advancing the fence and writing a leased/released pair for a lease that meant nothing.
    const executionProfileId = await seedPool('ceiling', 2)
    const running = await pool.seedWorkflow({ label: 'ceiling-holder', executionProfileId })
    const waiting = await pool.seedWorkflow({ label: 'ceiling-waiter', executionProfileId })

    await expect(
      admitWorkflow({ db: pool.db(), workflowId: running, ceiling: 1 }),
    ).resolves.toMatchObject({ outcome: 'admitted' })

    const before = await pool.audit()

    await expect(
      admitWorkflow({ db: pool.db(), workflowId: waiting, ceiling: 1 }),
    ).resolves.toMatchObject({ outcome: 'queued' })

    expect(await pool.liveLeases()).toHaveLength(1)
    expect(await pool.audit()).toHaveLength(before.length)
  }, 30_000)

  it('reserves nothing for a run that is not queued', async () => {
    const executionProfileId = await seedPool('cancelled', 1)
    const workflowId = await pool.seedWorkflow({
      label: 'cancelled-run',
      executionProfileId,
      state: 'cancelled',
    })

    await expect(admitWorkflow({ db: pool.db(), workflowId, ceiling: 4 })).resolves.toMatchObject({
      outcome: 'not_admissible',
      state: 'cancelled',
    })

    expect(await pool.liveLeases()).toHaveLength(0)
  }, 30_000)

  it('takes the seat exactly once when the same run is admitted twice (FR-015, FR-078)', async () => {
    const executionProfileId = await seedPool('coalesce', 3)
    const workflowId = await pool.seedWorkflow({ label: 'coalesce-run', executionProfileId })

    await expect(admitWorkflow({ db: pool.db(), workflowId, ceiling: 4 })).resolves.toMatchObject({
      outcome: 'admitted',
      reservation: 'acquired',
    })

    // The second admission coalesces, and must not take a second identity for one run — nor hand
    // back the one the first admission took, which the run is now using.
    await expect(admitWorkflow({ db: pool.db(), workflowId, ceiling: 4 })).resolves.toMatchObject({
      outcome: 'coalesced',
    })

    expect(await pool.liveLeases()).toHaveLength(1)
    expect(await pool.leases()).toHaveLength(1)
  }, 30_000)

  it('gives exactly one seat to each of several runs admitted at once (FR-017, SC-003)', async () => {
    const executionProfileId = await seedPool('concurrent', 3)
    const ids = await Promise.all(
      [0, 1, 2].map(async (index) =>
        pool.seedWorkflow({ label: `concurrent-${String(index)}`, executionProfileId }),
      ),
    )

    const outcomes = await Promise.all(
      ids.map(async (workflowId) => admitWorkflow({ db: pool.db(), workflowId, ceiling: 8 })),
    )

    expect(outcomes.filter((outcome) => outcome.outcome === 'admitted')).toHaveLength(3)

    const live = await pool.liveLeases()
    expect(live).toHaveLength(3)
    expect(new Set(live.map((lease) => lease.agentCredentialId)).size).toBe(3)
  }, 60_000)

  it('admits a run with no execution profile rather than making it wait for ever (T064)', async () => {
    // The carve-out, and the reason it is not an inconsistency. `selectFor` joins out from the
    // workflow to its execution profile's attachments and **so does the grant path**, so a run with
    // no profile — the ad-hoc case 002/FR-126 leaves null — is one no release, no registration and
    // no administrator action can ever be granted a seat to. Putting it in `awaiting_credential`
    // would enqueue it in a queue nothing can serve it from, and FR-028 would eventually fail it
    // naming an exhaustion that never happened.
    const workflowId = await pool.seedWorkflow({ label: 'no-profile' })

    const outcome = await admitWorkflow({ db: pool.db(), workflowId, ceiling: 4 })

    expect(outcome).toMatchObject({
      outcome: 'admitted',
      reservation: 'none_available',
      agentCredential: undefined,
    })
    expect(await pool.liveLeases()).toHaveLength(0)

    const [admitted] = await pool
      .db()
      .select({ detail: workflowEvents.detail })
      .from(workflowEvents)
      .where(eq(workflowEvents.workflowId, workflowId))
    // Recorded, and named: a run that started without a seat is visible, and the reason it did
    // distinguishes "there is no profile" from "the pool would not settle".
    expect(admitted.detail).toMatchObject({
      agentCredentialId: null,
      credentialReservation: 'none_available',
      credentialWaitReason: 'no_execution_profile',
    })
  }, 30_000)

  it('waits instead of provisioning when every reachable credential is held (FR-024, FR-025)', async () => {
    const executionProfileId = await seedPool('exhausted', 1)
    const holder = await pool.seedWorkflow({ label: 'exhausted-holder', executionProfileId })
    const later = await pool.seedWorkflow({ label: 'exhausted-later', executionProfileId })

    await admitWorkflow({ db: pool.db(), workflowId: holder, ceiling: 8 })

    const outcome = await admitWorkflow({ db: pool.db(), workflowId: later, ceiling: 8 })

    expect(outcome).toMatchObject({ outcome: 'awaiting_credential', entered: true })
    expect(outcome.outcome === 'awaiting_credential' ? outcome.reason.kind : undefined).toBe(
      'all_held',
    )

    const [waiting] = await pool
      .db()
      .select({ state: workflows.state })
      .from(workflows)
      .where(eq(workflows.id, later))
    expect(waiting.state).toBe('awaiting_credential')

    // SC-004: zero billed compute for the entire wait, and it is zero because nothing was taken.
    expect(await computeLeasesFor(later)).toBe(0)
    // Nor a seat: the holder's is the only one out.
    expect(await pool.liveLeases()).toHaveLength(1)

    const events = await pool
      .db()
      .select({ event: workflowEvents.event, detail: workflowEvents.detail })
      .from(workflowEvents)
      .where(eq(workflowEvents.workflowId, later))

    // No `admitted` entry, because it was not admitted. A timeline that said otherwise would make
    // a run that never started look like one that did.
    expect(events.map((entry) => entry.event)).toEqual(['queued'])
    expect(events[0]?.detail).toMatchObject({
      waitingOn: 'agent_credential',
      kind: 'all_held',
      configurationFault: false,
    })
    // FR-029: the groups that were searched, named on the run's own timeline.
    expect(
      (events[0]?.detail as { groups?: { name: string }[] } | null)?.groups?.[0]?.name,
    ).toContain('exhausted-group')
  }, 30_000)

  it('waits, and says so as a configuration fault, when the groups hold no credentials', async () => {
    // Nothing is held, so nothing will be released. The run still waits — an administrator
    // registering a credential in one of these groups is enough, and the drain then grants it — but
    // the flag is what stops an engineer being told to wait for capacity that is not coming.
    const credentialGroupId = await pool.seedGroup({ label: 'empty-group' })
    const executionProfileId = await pool.seedProfile({
      label: 'empty-profile',
      groups: [{ credentialGroupId, position: 1 }],
    })
    const workflowId = await pool.seedWorkflow({ label: 'empty-run', executionProfileId })

    const outcome = await admitWorkflow({ db: pool.db(), workflowId, ceiling: 4 })

    expect(outcome).toMatchObject({ outcome: 'awaiting_credential' })
    expect(
      outcome.outcome === 'awaiting_credential' ? outcome.reason.configurationFault : undefined,
    ).toBe(true)
    expect(await computeLeasesFor(workflowId)).toBe(0)
  }, 30_000)

  it('re-offers a waiting run without restarting its clock or its timeline (FR-028)', async () => {
    const executionProfileId = await seedPool('reoffer', 1)
    const holder = await pool.seedWorkflow({ label: 'reoffer-holder', executionProfileId })
    const waiter = await pool.seedWorkflow({ label: 'reoffer-waiter', executionProfileId })

    await admitWorkflow({ db: pool.db(), workflowId: holder, ceiling: 8 })
    const first = await admitWorkflow({ db: pool.db(), workflowId: waiter, ceiling: 8 })
    const second = await admitWorkflow({ db: pool.db(), workflowId: waiter, ceiling: 8 })

    expect(first).toMatchObject({ outcome: 'awaiting_credential', entered: true })
    expect(second).toMatchObject({ outcome: 'awaiting_credential', entered: false })
    // The same instant, from the entry the first call wrote. A clock restarted on every drain pass
    // is a limit that never fires, and a panel that says an hour-old wait is four seconds old.
    expect(second.outcome === 'awaiting_credential' ? second.since : undefined).toStrictEqual(
      first.outcome === 'awaiting_credential' ? first.since : undefined,
    )

    // And exactly one entry on the timeline, not one per pass.
    const events = await pool
      .db()
      .select({ event: workflowEvents.event })
      .from(workflowEvents)
      .where(eq(workflowEvents.workflowId, waiter))
    expect(events).toHaveLength(1)
  }, 30_000)

  it('admits a waiting run once a seat frees, through the same admission (FR-026)', async () => {
    const executionProfileId = await seedPool('granted', 1)
    const holder = await pool.seedWorkflow({ label: 'granted-holder', executionProfileId })
    const waiter = await pool.seedWorkflow({ label: 'granted-waiter', executionProfileId })

    await admitWorkflow({ db: pool.db(), workflowId: holder, ceiling: 8 })
    await expect(
      admitWorkflow({ db: pool.db(), workflowId: waiter, ceiling: 8 }),
    ).resolves.toMatchObject({ outcome: 'awaiting_credential' })

    await releaseLease({ db: pool.db(), workflowId: holder, reason: 'terminal' })

    // `awaiting_credential` is admissible, so the grant is not a second implementation of the
    // ceiling, the row lock and the FR-078 index — it is this function, run again.
    const granted = await admitWorkflow({ db: pool.db(), workflowId: waiter, ceiling: 8 })

    expect(granted).toMatchObject({ outcome: 'admitted', reservation: 'acquired' })
    expect(await computeLeasesFor(waiter)).toBe(1)

    const [state] = await pool
      .db()
      .select({ state: workflows.state })
      .from(workflows)
      .where(eq(workflows.id, waiter))
    expect(state.state).toBe('provisioning')
  }, 30_000)
})
