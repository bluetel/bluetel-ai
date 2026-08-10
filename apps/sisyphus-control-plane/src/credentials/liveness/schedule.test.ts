import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { CredentialPoolFixtures } from '../allocate/pool-fixtures'
import {
  createCredentialPoolFixtures,
  createGate,
  readTestDatabaseUrl,
} from '../allocate/pool-fixtures'
import { acquireCredential } from '../lease'

import type { CredentialExerciser } from './exercise'
import { createFakeCredentialExerciser } from './exercise-fake'
import {
  claimForKeepAlive,
  credentialsDueForKeepAlive,
  releaseKeepAliveClaim,
  sweepKeepAlive,
} from './schedule'

/**
 * **T083 — the keep-alive suite. Three claims, and the third is why the file is shaped like this.**
 *
 * 1. **Every member of an untouched lower-preference group is exercised** (FR-035, SC-009). This is
 *    the case that proves least-recently-used selection would not have sufficed: a profile draws
 *    from its first attached group until that group is exhausted, so a second group can receive no
 *    traffic at all while LRU inside the first reports perfect evenness. The test drives real
 *    workflow traffic through group A and then asserts that every seat in group B — which no
 *    workflow ever reached — was exercised anyway.
 * 2. **A leased or disabled credential is skipped** (FR-036).
 * 3. **A keep-alive claim racing a workflow reservation for the same idle seat resolves to exactly
 *    one winner, and the loser observes zero rows affected** (FR-038). Driven in **both orderings**.
 *
 * ## Why the third is a separate test, and not a stronger version of the second
 *
 * Because a read-then-act implementation passes the second and fails the third, and the whole point
 * of writing them apart is that the second cannot detect the bug. "Skip anything that is not
 * `available`" is true of a read-then-act claimer: it reads `available`, finds the leased row
 * absent from its due set, and never touches it. The bug only appears when the read and the act
 * straddle somebody else's commit — when two claimants **both** read `available` and both proceed.
 *
 * ## Making the race real rather than nominal
 *
 * `Promise.all` over two calls is not evidence: Node would interleave them, but so would a run in
 * which the first finished before the second began, and a serialised execution passes the same
 * assertions. So the race is constructed, with the technique `lease/acquire.test.ts` established. A
 * gate transaction takes `SELECT … FOR UPDATE` over the credential and parks. Both claimants then
 * run: `FOR UPDATE` does not block a plain read, so both *see* an available credential — exactly as
 * they would if they had looked at the pool in the same instant — and both then block on the row
 * lock at their `UPDATE`. The suite waits until `pg_stat_activity` shows **two backends parked on a
 * lock**, asserts that neither call has settled, and only then opens the gate. Postgres decides the
 * race; the test does not, and the "ordering" is which claimant was launched first.
 *
 * ## How I satisfied myself the race test would fail against a read-then-act implementation
 *
 * By writing one and running it through the identical choreography. {@link readThenActClaim} below
 * is the wrong implementation spelled out — `SELECT state`, then `UPDATE … WHERE id = :id` with no
 * state predicate — and the last test in this file puts it in the race in place of
 * `claimForKeepAlive` and asserts that **both** parties come away believing they hold the seat, and
 * that the credential row ends up saying `keep_alive` while a live lease names the workflow. That
 * is the same technique `acquire.test.ts` uses when it drops `credential_leases_live_key` and
 * watches two live leases appear: a test that cannot fail is not evidence, and the only way to know
 * this one can is to take the guarantee away and watch it go.
 */

const connectionString = readTestDatabaseUrl()

const sleep = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

/** Comfortably past `IDLE_HOURS`, so a seeded credential is unambiguously overdue. */
const LONG_AGO = new Date('2026-01-01T00:00:00.000Z')

/** Comfortably inside it. */
const JUST_NOW = new Date()

const IDLE_HOURS = 24

describe.skipIf(connectionString === undefined)('the keep-alive schedule', () => {
  // Narrowed once: `describe.skipIf` has already decided, but TypeScript has not seen it.
  const url = connectionString ?? ''
  const fixtures: CredentialPoolFixtures = createCredentialPoolFixtures(url)

  /**
   * The wrong implementation, kept here so the race test can be shown to have teeth.
   *
   * It reads the state and then acts on it, which is the shape every reviewer's instinct produces
   * and which passes the FR-036 skip test above. The `UPDATE` carries no state predicate, so it
   * matches whatever the row has become in the meantime — including a seat a workflow committed to
   * a microsecond earlier.
   */
  const readThenActClaim = async (agentCredentialId: string): Promise<boolean> =>
    fixtures.db().transaction(async (tx) => {
      const seen = await tx.execute<{ state: string }>(
        sql`select state from agent_credentials where id = ${agentCredentialId}`,
      )

      if ([...seen][0]?.state !== 'available') {
        return false
      }

      await tx.execute(
        sql`update agent_credentials set state = 'held', held_by = 'keep_alive' where id = ${agentCredentialId}`,
      )
      return true
    })

  beforeAll(async () => {
    await fixtures.open()
  }, 120_000)

  afterAll(async () => {
    await fixtures.close()
  }, 120_000)

  afterEach(async () => {
    await fixtures.clearLeases()
    await fixtures.execute('delete from keep_alive_runs')
    await fixtures.execute('delete from agent_credentials')
    await fixtures.execute('delete from profile_credential_groups')
  })

  describe('every seat is exercised, including in a group nothing ever draws from (FR-035)', () => {
    it('exercises every member of an untouched lower-preference group', async () => {
      // Two groups on one profile, in preference order. Everything in both is overdue.
      const preferred = await fixtures.seedGroup({ label: 'preferred' })
      const fallback = await fixtures.seedGroup({ label: 'fallback' })
      const profileId = await fixtures.seedProfile({
        label: 'ordered',
        groups: [
          { credentialGroupId: preferred, position: 1 },
          { credentialGroupId: fallback, position: 2 },
        ],
      })

      const preferredSeats: string[] = []
      const fallbackSeats: string[] = []
      for (let index = 0; index < 3; index += 1) {
        preferredSeats.push(
          await fixtures.seedCredential({
            label: `preferred-${index}`,
            credentialGroupId: preferred,
            lastExercisedAt: LONG_AGO,
          }),
        )
        fallbackSeats.push(
          await fixtures.seedCredential({
            label: `fallback-${index}`,
            credentialGroupId: fallback,
            lastExercisedAt: LONG_AGO,
          }),
        )
      }

      // Real traffic, through the real allocator, and only as much of it as the preferred group can
      // absorb — which is the whole point. Selection prefers `position` first, so all three
      // workflows land in the preferred group and the fallback group sees nothing at all.
      for (let index = 0; index < 3; index += 1) {
        const workflowId = await fixtures.seedWorkflow({
          label: `runner-${index}`,
          executionProfileId: profileId,
        })
        const acquired = await acquireCredential({ db: fixtures.db(), workflowId })
        expect(acquired.outcome).toBe('acquired')
      }

      const touchedByWorkflows = (await fixtures.liveLeases()).map(
        (lease) => lease.agentCredentialId,
      )
      expect(new Set(touchedByWorkflows)).toStrictEqual(new Set(preferredSeats))
      // Stated explicitly, because it is the premise: least-recently-used never reached these.
      for (const seat of fallbackSeats) {
        expect(touchedByWorkflows).not.toContain(seat)
      }

      const exerciser = createFakeCredentialExerciser()
      const result = await sweepKeepAlive({ db: fixtures.db(), exerciser, idleHours: IDLE_HOURS })

      // Every member of the untouched group, not merely one of them or the oldest of them.
      for (const seat of fallbackSeats) {
        expect(exerciser.exercised()).toContain(seat)
        const credential = await fixtures.credential(seat)
        expect(credential?.lastExercisedAt).not.toBeNull()
        expect(credential?.state).toBe('available')
        expect(credential?.heldBy).toBeNull()
      }

      // And the leased ones were left alone, which is the same pass proving FR-036 as a by-product.
      expect(result.considered).toBe(fallbackSeats.length)
      expect(result.exercised).toBe(fallbackSeats.length)
    })

    it('does not care which group a credential is in when deciding it is overdue', async () => {
      // No profile attaches either group, so nothing could ever draw on them. Keep-alive still must.
      const orphanA = await fixtures.seedGroup({ label: 'orphan-a' })
      const orphanB = await fixtures.seedGroup({ label: 'orphan-b' })
      const seats = [
        await fixtures.seedCredential({
          label: 'orphan-a-0',
          credentialGroupId: orphanA,
          lastExercisedAt: LONG_AGO,
        }),
        await fixtures.seedCredential({
          label: 'orphan-b-0',
          credentialGroupId: orphanB,
          lastExercisedAt: LONG_AGO,
        }),
      ]

      const exerciser = createFakeCredentialExerciser()
      await sweepKeepAlive({ db: fixtures.db(), exerciser, idleHours: IDLE_HOURS })

      expect([...exerciser.exercised()].sort()).toStrictEqual([...seats].sort())
    })

    it('leaves a credential exercised inside the threshold alone', async () => {
      const groupId = await fixtures.seedGroup({ label: 'fresh' })
      await fixtures.seedCredential({
        label: 'recent',
        credentialGroupId: groupId,
        lastExercisedAt: JUST_NOW,
      })

      const exerciser = createFakeCredentialExerciser()
      const result = await sweepKeepAlive({ db: fixtures.db(), exerciser, idleHours: IDLE_HOURS })

      expect(result.considered).toBe(0)
      expect(exerciser.exercised()).toStrictEqual([])
    })

    it('treats a credential nothing has ever proved as the most overdue thing there is', async () => {
      const groupId = await fixtures.seedGroup({ label: 'never' })
      const never = await fixtures.seedCredential({
        label: 'never-proved',
        credentialGroupId: groupId,
        lastExercisedAt: null,
      })
      const old = await fixtures.seedCredential({
        label: 'old',
        credentialGroupId: groupId,
        lastExercisedAt: LONG_AGO,
      })

      const exerciser = createFakeCredentialExerciser()
      await sweepKeepAlive({ db: fixtures.db(), exerciser, idleHours: IDLE_HOURS })

      // Nulls first. A fresh registration that never worked should be found on the first pass, not
      // a day later by the workflow that got it.
      expect(exerciser.exercised()).toStrictEqual([never, old])
    })
  })

  describe('a leased or disabled credential is skipped (FR-036)', () => {
    it('skips a credential a workflow holds', async () => {
      const groupId = await fixtures.seedGroup({ label: 'busy' })
      const profileId = await fixtures.seedProfile({
        label: 'busy',
        groups: [{ credentialGroupId: groupId, position: 1 }],
      })
      const leased = await fixtures.seedCredential({
        label: 'leased',
        credentialGroupId: groupId,
        lastExercisedAt: LONG_AGO,
      })
      const idle = await fixtures.seedCredential({
        label: 'idle',
        credentialGroupId: groupId,
        lastExercisedAt: LONG_AGO,
      })

      const workflowId = await fixtures.seedWorkflow({
        label: 'holder',
        executionProfileId: profileId,
      })
      const acquired = await acquireCredential({ db: fixtures.db(), workflowId })
      expect(acquired.outcome === 'acquired' && acquired.agentCredentialId).toBe(leased)

      const exerciser = createFakeCredentialExerciser()
      await sweepKeepAlive({ db: fixtures.db(), exerciser, idleHours: IDLE_HOURS })

      // A held credential is being exercised by the run holding it; a keep-alive on top of that is
      // the concurrent use FR-038 forbids.
      expect(exerciser.exercised()).toStrictEqual([idle])
      expect((await fixtures.credential(leased))?.heldBy).toBe('workflow')
    })

    it('skips a credential an administrator has disabled', async () => {
      const groupId = await fixtures.seedGroup({ label: 'withheld' })
      await fixtures.seedCredential({
        label: 'off',
        credentialGroupId: groupId,
        enabled: false,
        lastExercisedAt: LONG_AGO,
      })

      const exerciser = createFakeCredentialExerciser()
      const result = await sweepKeepAlive({ db: fixtures.db(), exerciser, idleHours: IDLE_HOURS })

      expect(result.considered).toBe(0)
      expect(exerciser.exercised()).toStrictEqual([])
    })

    it('skips a credential in every other unselectable state', async () => {
      const groupId = await fixtures.seedGroup({ label: 'states' })
      for (const state of ['awaiting_login', 'cooling_off', 'unhealthy', 'disabled'] as const) {
        await fixtures.seedCredential({
          label: `state-${state}`,
          credentialGroupId: groupId,
          state,
          lastExercisedAt: LONG_AGO,
        })
      }

      const exerciser = createFakeCredentialExerciser()
      const result = await sweepKeepAlive({ db: fixtures.db(), exerciser, idleHours: IDLE_HOURS })

      // Only `available` is named in the query, so a state added to the enum later is skipped by
      // default — which is the safe direction for a set whose failure mode is double use.
      expect(result.considered).toBe(0)
    })

    it('skips a credential with nothing to exercise (FR-008)', async () => {
      const groupId = await fixtures.seedGroup({ label: 'material' })
      await fixtures.seedCredential({
        label: 'no-material',
        credentialGroupId: groupId,
        secretId: null,
        lastExercisedAt: LONG_AGO,
      })

      const exerciser = createFakeCredentialExerciser()
      expect(
        (await sweepKeepAlive({ db: fixtures.db(), exerciser, idleHours: IDLE_HOURS })).considered,
      ).toBe(0)
    })

    it('skips an archived credential and an archived group, which are history rather than capacity', async () => {
      const live = await fixtures.seedGroup({ label: 'live' })
      const gone = await fixtures.seedGroup({ label: 'gone', archived: true })
      await fixtures.seedCredential({
        label: 'archived',
        credentialGroupId: live,
        archived: true,
        lastExercisedAt: LONG_AGO,
      })
      await fixtures.seedCredential({
        label: 'in-archived-group',
        credentialGroupId: gone,
        lastExercisedAt: LONG_AGO,
      })

      const exerciser = createFakeCredentialExerciser()
      expect(
        (await sweepKeepAlive({ db: fixtures.db(), exerciser, idleHours: IDLE_HOURS })).considered,
      ).toBe(0)
    })

    it('still exercises a credential whose group is disabled, because a disabled group rots too', async () => {
      // The judgement call, asserted so it is a decision rather than an accident. FR-036 names two
      // exemptions and this is not one of them; a group disabled for a month and then re-enabled is
      // exactly the pool rot SC-009 is about. See the note in `schedule.ts`.
      const groupId = await fixtures.seedGroup({ label: 'paused-group', enabled: false })
      const seat = await fixtures.seedCredential({
        label: 'in-disabled-group',
        credentialGroupId: groupId,
        lastExercisedAt: LONG_AGO,
      })

      const exerciser = createFakeCredentialExerciser()
      await sweepKeepAlive({ db: fixtures.db(), exerciser, idleHours: IDLE_HOURS })

      expect(exerciser.exercised()).toStrictEqual([seat])
    })
  })

  describe('a keep-alive claim racing a workflow reservation (FR-038)', () => {
    /**
     * Seed one group, one profile, one credential and one workflow — a pool with exactly one idle
     * seat, so the two claimants have nothing to do but contend for it.
     */
    const seedContestedSeat = async (
      label: string,
    ): Promise<{ credentialId: string; workflowId: string; groupId: string }> => {
      const groupId = await fixtures.seedGroup({ label })
      const profileId = await fixtures.seedProfile({
        label,
        groups: [{ credentialGroupId: groupId, position: 1 }],
      })
      const credentialId = await fixtures.seedCredential({
        label: `${label}-seat`,
        credentialGroupId: groupId,
        lastExercisedAt: LONG_AGO,
      })
      const workflowId = await fixtures.seedWorkflow({ label, executionProfileId: profileId })

      return { credentialId, workflowId, groupId }
    }

    /** Wait until Postgres reports at least `count` backends parked on a lock, and say what it saw. */
    const parkedOnLocks = async (count: number): Promise<number> => {
      let blocked = 0
      for (let attempt = 0; attempt < 400 && blocked < count; attempt += 1) {
        await sleep(25)
        blocked = await fixtures.backendsWaitingOnLocks()
      }
      return blocked
    }

    /**
     * Run two claimants into the same row lock and let Postgres decide.
     *
     * **The second claimant is not launched until Postgres reports the first parked on the lock.**
     * That is what makes "both orderings" mean something: the lock queue is served in the order
     * waiters joined it, so staggering the launches decides which of the two commits first, and the
     * assertion is then about what happens to the other one. Launching both at once would leave the
     * order to chance, and a race test whose outcome the test cannot name is a race test that will
     * one day fail for the right reason and be believed to be flaky.
     *
     * Everything else follows `lease/acquire.test.ts`: a gate transaction holds `FOR UPDATE` on the
     * contested row while both claimants take their plain read — so both genuinely see an available
     * credential, exactly as they would if they had looked in the same instant — and neither can
     * proceed past its `UPDATE` until the gate opens.
     *
     * @param claim - How the keep-alive side claims. The real one, or the deliberately wrong one.
     * @param keepAliveFirst - Which claimant joins the lock queue first.
     */
    const race = async (options: {
      readonly credentialId: string
      readonly workflowId: string
      readonly claim: (agentCredentialId: string) => Promise<boolean>
      readonly keepAliveFirst: boolean
    }): Promise<{ keepAliveWon: boolean; workflowWon: boolean }> => {
      const locked = createGate()
      const release = createGate()

      // The gate: the contested row locked, and the transaction parked holding it.
      const gate = fixtures.db().transaction(async (tx) => {
        await tx.execute(
          sql`select id from agent_credentials where id = ${options.credentialId} for update`,
        )
        locked.open()
        await release.opened
        return 'gate closed'
      })

      await locked.opened
      // Postgres confirming the gate really is open, rather than a promise that has merely not
      // resolved — which a transaction that never began would satisfy just as well.
      expect(await fixtures.backendsInTransaction()).toBeGreaterThan(0)

      let settled = 0
      const settling = <TResult>(promise: Promise<TResult>): Promise<TResult> =>
        promise.finally(() => {
          settled += 1
        })

      // Rejection handlers are attached at construction, so nothing is ever momentarily unhandled.
      const startKeepAlive = (): Promise<boolean> => settling(options.claim(options.credentialId))
      const startReservation = (): Promise<boolean> =>
        settling(
          acquireCredential({ db: fixtures.db(), workflowId: options.workflowId }).then(
            (outcome) => outcome.outcome === 'acquired',
          ),
        )

      const first = options.keepAliveFirst ? startKeepAlive() : startReservation()
      expect(await parkedOnLocks(1)).toBeGreaterThanOrEqual(1)

      const second = options.keepAliveFirst ? startReservation() : startKeepAlive()
      const both = Promise.all([first, second])

      // Without this wait, a run in which the two simply executed one after another would look
      // identical to one in which they contended — and only the second proves anything.
      expect(await parkedOnLocks(2)).toBe(2)
      expect(settled).toBe(0)

      release.open()
      await expect(gate).resolves.toBe('gate closed')

      const [firstWon, secondWon] = await both

      return options.keepAliveFirst
        ? { keepAliveWon: firstWon, workflowWon: secondWon }
        : { keepAliveWon: secondWon, workflowWon: firstWon }
    }

    for (const keepAliveFirst of [true, false]) {
      it(`resolves to exactly one winner with the ${keepAliveFirst ? 'keep-alive' : 'reservation'} launched first`, async () => {
        const seat = await seedContestedSeat(`race-${String(keepAliveFirst)}`)

        const { keepAliveWon, workflowWon } = await race({
          credentialId: seat.credentialId,
          workflowId: seat.workflowId,
          claim: (id) => claimForKeepAlive(fixtures.db(), id),
          keepAliveFirst,
        })

        // Exactly one. Not "at least one", which two winners would also satisfy.
        expect([keepAliveWon, workflowWon].filter(Boolean)).toHaveLength(1)

        const credential = await fixtures.credential(seat.credentialId)
        expect(credential?.state).toBe('held')
        expect(credential?.heldBy).toBe(keepAliveWon ? 'keep_alive' : 'workflow')

        // And the loser's account matches. A keep-alive that lost saw zero rows affected and said
        // so; a reservation that lost re-selected against a pool that no longer had anything and
        // reported a wait rather than an error.
        const live = await fixtures.liveLeases()
        expect(live).toHaveLength(workflowWon ? 1 : 0)

        if (keepAliveWon) {
          // The yielding side moves on, and hands the seat back when its exercise finishes.
          expect(await releaseKeepAliveClaim(fixtures.db(), seat.credentialId)).toBe('available')
        }
      }, 120_000)
    }

    it('observes zero rows affected when a reservation took the seat first', async () => {
      // The loser's account, at the level of the primitive and without any race machinery — because
      // this is the *ordinary* window, not an exotic one: `credentialsDueForKeepAlive` reads, and
      // by the time the claim is attempted a reservation may have committed.
      const seat = await seedContestedSeat('yielding')

      const due = await credentialsDueForKeepAlive(fixtures.db(), { idleHours: IDLE_HOURS })
      expect(due.map((candidate) => candidate.agentCredentialId)).toStrictEqual([seat.credentialId])

      const acquired = await acquireCredential({ db: fixtures.db(), workflowId: seat.workflowId })
      expect(acquired.outcome).toBe('acquired')

      // Zero rows, reported as `false` — an answer and not a failure. A read-then-act check would
      // have found `available` in the set it had already read and gone ahead.
      expect(await claimForKeepAlive(fixtures.db(), seat.credentialId)).toBe(false)
      expect((await fixtures.credential(seat.credentialId))?.heldBy).toBe('workflow')
    })

    it('reports a yielded seat rather than swallowing it', async () => {
      // The same rule seen from the sweep's return value. A pass that yielded on most of the pool
      // proved very little, and a schedule that could not say so would look identical to one that
      // had worked. The window is constructed for real: the seat is taken *during* the exercise of
      // the credential before it, which is exactly when it happens in production.
      const groupId = await fixtures.seedGroup({ label: 'stolen' })
      const profileId = await fixtures.seedProfile({
        label: 'stolen',
        groups: [{ credentialGroupId: groupId, position: 1 }],
      })
      const first = await fixtures.seedCredential({
        label: 'stolen-aaa',
        credentialGroupId: groupId,
        lastExercisedAt: new Date('2026-01-01T00:00:00.000Z'),
      })
      const second = await fixtures.seedCredential({
        label: 'stolen-bbb',
        credentialGroupId: groupId,
        lastExercisedAt: new Date('2026-01-02T00:00:00.000Z'),
      })
      const workflowId = await fixtures.seedWorkflow({
        label: 'stealer',
        executionProfileId: profileId,
      })

      const stealing: CredentialExerciser = {
        exercise: async (request) => {
          if (request.agentCredentialId === first) {
            // A workflow admitted while the sweep was mid-pass, taking the seat the sweep had
            // already read as due.
            const acquired = await acquireCredential({ db: fixtures.db(), workflowId })
            expect(acquired.outcome === 'acquired' && acquired.agentCredentialId).toBe(second)
          }
          return { outcome: 'succeeded' }
        },
      }

      const result = await sweepKeepAlive({
        db: fixtures.db(),
        exerciser: stealing,
        idleHours: IDLE_HOURS,
      })

      expect(result.considered).toBe(2)
      expect(result.exercised).toBe(1)
      expect(result.yielded).toBe(1)
      expect(result.attempts[1]).toMatchObject({
        agentCredentialId: second,
        result: { outcome: 'yielded' },
        releasedTo: undefined,
      })
      // And the reservation kept what it took: yielding means yielding.
      expect((await fixtures.credential(second))?.heldBy).toBe('workflow')
    })

    it('would let both parties win against a read-then-act claim, which is why the race test exists', async () => {
      // **This test asserts the bug**, deliberately, and it is the only way to know the two tests
      // above have teeth. Run the identical choreography with the wrong implementation and watch
      // one agent identity end up claimed by a keep-alive while a live lease names a workflow.
      //
      // The reservation is launched first, so it is the one that commits: the read-then-act claim
      // then wakes with a `WHERE id = :id` that no longer says anything about the state, matches
      // the row a workflow has just taken, and overwrites it.
      const seat = await seedContestedSeat('read-then-act')

      const { keepAliveWon, workflowWon } = await race({
        credentialId: seat.credentialId,
        workflowId: seat.workflowId,
        claim: readThenActClaim,
        keepAliveFirst: false,
      })

      expect(keepAliveWon).toBe(true)
      expect(workflowWon).toBe(true)
      expect([keepAliveWon, workflowWon].filter(Boolean)).toHaveLength(2)

      // The state the platform must never reach: a live lease saying a workflow is authenticated as
      // this identity, and the credential row saying a keep-alive is exercising it at the same
      // time. Nothing in the row afterwards records that anything went wrong, which is precisely
      // why this cannot be left to a check somewhere.
      expect(await fixtures.liveLeases()).toHaveLength(1)
      expect((await fixtures.credential(seat.credentialId))?.heldBy).toBe('keep_alive')
    }, 120_000)
  })

  describe('the seat is handed back whatever the exercise concluded', () => {
    it('returns a healthy credential to the pool', async () => {
      const groupId = await fixtures.seedGroup({ label: 'healthy' })
      const seat = await fixtures.seedCredential({
        label: 'healthy',
        credentialGroupId: groupId,
        lastExercisedAt: LONG_AGO,
      })

      const exerciser = createFakeCredentialExerciser()
      const result = await sweepKeepAlive({ db: fixtures.db(), exerciser, idleHours: IDLE_HOURS })

      expect(result.attempts[0]?.releasedTo).toBe('available')
      const credential = await fixtures.credential(seat)
      expect(credential?.state).toBe('available')
      expect(credential?.heldBy).toBeNull()
    })

    it('does not return a credential the exercise found broken (release is not a repair)', async () => {
      const groupId = await fixtures.seedGroup({ label: 'broken' })
      const seat = await fixtures.seedCredential({
        label: 'broken',
        credentialGroupId: groupId,
        lastExercisedAt: LONG_AGO,
      })

      const exerciser = createFakeCredentialExerciser({
        otherwise: { outcome: 'refused', response: { status: 401, body: 'invalid api key' } },
      })
      const result = await sweepKeepAlive({ db: fixtures.db(), exerciser, idleHours: IDLE_HOURS })

      // Returning it to `available` would hand the next workflow the failure this pass had just
      // discovered — which is what `lease/release.ts` says at length about its own `CASE`.
      expect(result.failed).toBe(1)
      const credential = await fixtures.credential(seat)
      expect(credential?.state).toBe('unhealthy')
      expect(credential?.heldBy).toBeNull()
    })

    it('hands the seat back even when the exerciser throws, and ends the pass', async () => {
      const groupId = await fixtures.seedGroup({ label: 'throwing' })
      const first = await fixtures.seedCredential({
        label: 'aaa-first',
        credentialGroupId: groupId,
        lastExercisedAt: new Date('2026-01-01T00:00:00.000Z'),
      })
      const second = await fixtures.seedCredential({
        label: 'bbb-second',
        credentialGroupId: groupId,
        lastExercisedAt: new Date('2026-01-02T00:00:00.000Z'),
      })

      const exerciser = createFakeCredentialExerciser({
        throwsFor: { [first]: new Error('no exerciser is wired') },
      })

      await expect(
        sweepKeepAlive({ db: fixtures.db(), exerciser, idleHours: IDLE_HOURS }),
      ).rejects.toThrow('no exerciser is wired')

      // The claim is released on the way out — there is no lease row for the FR-022 sweep to find,
      // so a leaked keep-alive claim would be a seat held by nothing until somebody edited the row.
      const credential = await fixtures.credential(first)
      expect(credential?.state).toBe('available')
      expect(credential?.heldBy).toBeNull()

      // And the pass ended rather than repeating the same platform failure once per credential:
      // the second seat was never reached, and its liveness clock is exactly where it was seeded.
      expect(exerciser.exercised()).toStrictEqual([first])
      expect((await fixtures.credential(second))?.lastExercisedAt?.toISOString()).toBe(
        '2026-01-02T00:00:00.000Z',
      )
    })
  })
})
