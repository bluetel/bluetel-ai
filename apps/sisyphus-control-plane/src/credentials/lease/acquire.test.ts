import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { CredentialPoolFixtures } from '../allocate/pool-fixtures'
import {
  createCredentialPoolFixtures,
  createGate,
  readTestDatabaseUrl,
} from '../allocate/pool-fixtures'

import type { AcquisitionOutcome } from './acquire'
import { acquireCredential, LEASE_EXCLUSIVITY_INDEX } from './acquire'

/**
 * **The exclusivity race suite (T038) — the single most important test in this feature.**
 *
 * SC-003 is the claim that two workflows are never simultaneously authenticated as the same agent
 * identity, *under concurrent load equal to twice the pool size*. That number is in the success
 * criterion because it is the load at which a read-then-act allocator looks correct in every
 * sequential test and hands one seat to two runs in production. So this suite runs exactly that:
 * `2N` acquisitions against `N` credentials, and asserts that exactly `N` of them come back holding
 * something.
 *
 * ## Making the concurrency real rather than nominal
 *
 * `Promise.all` over `2N` calls is **not** evidence. Node would happily interleave them, but so
 * would a run in which each transaction happened to finish before the next one began — and a
 * serialised execution passes the same assertions a concurrent one does. A test that cannot tell
 * those apart is not testing the guarantee, it is testing the arithmetic.
 *
 * So the race is constructed rather than hoped for. A gate transaction takes `SELECT … FOR UPDATE`
 * over every credential in the pool and then parks. All `2N` acquisitions run, select a credential
 * — `FOR UPDATE` does not block a plain read, so selection succeeds for all of them, exactly as it
 * would if they had all looked at the pool at the same instant — and then block on the row lock at
 * their conditional `UPDATE`. The suite waits until `pg_stat_activity` shows **all `2N` backends
 * parked on a lock**, asserts that none of the calls has settled, and only then opens the gate, so
 * every acquisition is released into the contended state simultaneously. Postgres decides the race;
 * the test does not.
 *
 * ## Making sure the test would fail if the guarantee were removed
 *
 * A conditional `UPDATE … WHERE state = 'available'` takes a row lock, so under this design the
 * losers lose on the update and the partial unique index is never reached. That is a good property
 * of the allocator and a bad property of a test suite: it means the headline race would pass with
 * `credential_leases_live_key` dropped, and a test that cannot fail is not evidence.
 *
 * Two tests below close that hole. One constructs **drift** — a credential row saying `available`
 * while a live lease names it, which is exactly what the FR-022 reconciliation sweep exists to
 * repair — so the conditional update succeeds and the index is the only thing left to refuse the
 * second holder. The other drops `credential_leases_live_key`, runs the same acquisition, and
 * asserts that a second live lease *does* appear, before restoring the index. The second test is
 * uncomfortable to write and is the only way to know the first one has teeth.
 */

const connectionString = readTestDatabaseUrl()

/**
 * `N`. Small enough that `2N` transactions, a gate and a watcher fit comfortably inside the
 * fixture's connection pool; large enough that "exactly N succeeded" is a real count rather than a
 * coin flip.
 */
const POOL_SIZE = 4

const sleep = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

describe.skipIf(connectionString === undefined)('acquiring a credential', () => {
  // Narrowed once: `describe.skipIf` has already decided, but TypeScript has not seen it.
  const url = connectionString ?? ''
  const fixtures: CredentialPoolFixtures = createCredentialPoolFixtures(url)

  let groupId = ''
  let profileId = ''
  let credentialIds: string[] = []

  beforeAll(async () => {
    await fixtures.open()
    groupId = await fixtures.seedGroup({ label: 'race' })
    profileId = await fixtures.seedProfile({
      label: 'race',
      groups: [{ credentialGroupId: groupId, position: 1 }],
    })
    credentialIds = []
    for (let index = 0; index < POOL_SIZE; index += 1) {
      credentialIds.push(
        await fixtures.seedCredential({ label: `seat-${index}`, credentialGroupId: groupId }),
      )
    }
  }, 120_000)

  // The same generous budget `beforeAll` gets, and for the mirror-image reason: `close()` issues
  // `drop database … with (force)` against a server several suites are concurrently creating and
  // dropping databases on, and the default ten seconds is a limit on the container rather than on
  // anything this suite does.
  afterAll(async () => {
    await fixtures.close()
  }, 120_000)

  afterEach(async () => {
    // Leases, audit rows and the workflow back-references are the only things acquisition writes
    // outside the credential rows; the credentials themselves are put back by hand below so that
    // every test starts from "N idle seats, fence wherever the last test left it".
    await fixtures.clearLeases()
    await fixtures
      .db()
      .execute(
        sql`update agent_credentials set state = 'available', held_by = null where credential_group_id = ${groupId}`,
      )
  })

  const seedWorkflows = async (count: number, label: string): Promise<string[]> => {
    const ids: string[] = []
    for (let index = 0; index < count; index += 1) {
      ids.push(
        await fixtures.seedWorkflow({
          label: `${label}-${index}`,
          executionProfileId: profileId,
          state: 'queued',
        }),
      )
    }
    return ids
  }

  it(`lets exactly ${String(POOL_SIZE)} of ${String(2 * POOL_SIZE)} concurrent acquisitions win (FR-017, SC-003)`, async () => {
    const workflowIds = await seedWorkflows(2 * POOL_SIZE, 'racer')

    const locked = createGate()
    const release = createGate()

    // The gate: every credential in the pool locked, and the transaction parked holding them.
    const gate = fixtures.db().transaction(async (tx) => {
      await tx.execute(
        sql`select id from agent_credentials where credential_group_id = ${groupId} for update`,
      )
      locked.open()
      await release.opened
      return 'gate closed'
    })

    await locked.opened
    // Postgres confirming the gate is really open, rather than a promise that has merely not
    // resolved — which a transaction that never began would satisfy just as well.
    expect(await fixtures.backendsInTransaction()).toBeGreaterThan(0)

    let settled = 0
    const acquisitions = workflowIds.map((workflowId) =>
      acquireCredential({ db: fixtures.db(), workflowId }).finally(() => {
        settled += 1
      }),
    )
    // Attached before the gate opens, so no rejection is ever momentarily unhandled.
    const outcomes = Promise.all(acquisitions)

    // Without this wait, a run in which the acquisitions simply executed one after another would
    // look identical to one in which they contended — and only the second proves anything.
    let blocked = 0
    for (let attempt = 0; attempt < 400 && blocked < 2 * POOL_SIZE; attempt += 1) {
      await sleep(25)
      blocked = await fixtures.backendsWaitingOnLocks()
    }
    expect(blocked).toBe(2 * POOL_SIZE)
    expect(settled).toBe(0)

    release.open()
    await expect(gate).resolves.toBe('gate closed')

    const results = await outcomes
    const acquired = results.filter((result) => result.outcome === 'acquired')
    const empty = results.filter((result) => result.outcome === 'none_available')

    expect(acquired).toHaveLength(POOL_SIZE)
    expect(empty).toHaveLength(POOL_SIZE)
    expect(results).toHaveLength(2 * POOL_SIZE)

    // The property the index guarantees, stated as a property of the rows rather than of the
    // return values: no credential appears on two live leases.
    const live = await fixtures.liveLeases()
    expect(live).toHaveLength(POOL_SIZE)
    expect(new Set(live.map((lease) => lease.agentCredentialId)).size).toBe(POOL_SIZE)
    expect(new Set(live.map((lease) => lease.workflowId)).size).toBe(POOL_SIZE)

    // Every seat the winners took is held, by a workflow, at the fence its lease carries.
    for (const lease of live) {
      const credential = await fixtures.credential(lease.agentCredentialId)
      expect(credential?.state).toBe('held')
      expect(credential?.heldBy).toBe('workflow')
      expect(credential?.fence).toBe(lease.fence)
      expect(credential?.lastUsedAt).not.toBeNull()
    }

    // FR-058, SC-013: one audit entry per acquisition that happened, and none for one that did not.
    const audit = await fixtures.audit()
    const leased = audit.filter((entry) => entry.action === 'leased')
    expect(leased).toHaveLength(POOL_SIZE)
    expect(audit).toHaveLength(POOL_SIZE)
    expect(new Set(leased.map((entry) => entry.entityId))).toStrictEqual(
      new Set(live.map((lease) => lease.agentCredentialId)),
    )
  }, 120_000)

  it('gives a losing acquisition an answer rather than an error', async () => {
    // A pool with nothing free is a wait, not a failure (FR-024 turns this into
    // `awaiting_credential` in the next phase). It must not throw, and it must not report a seat.
    const [holder, waiter] = await seedWorkflows(2, 'single')
    await fixtures
      .db()
      .execute(
        sql`update agent_credentials set state = 'held', held_by = 'workflow' where credential_group_id = ${groupId} and id <> ${credentialIds[0]}`,
      )

    const first = await acquireCredential({ db: fixtures.db(), workflowId: holder })
    expect(first.outcome).toBe('acquired')

    const second = await acquireCredential({ db: fixtures.db(), workflowId: waiter })
    expect(second).toStrictEqual({
      outcome: 'none_available',
      workflowId: waiter,
      attempts: 1,
    } satisfies AcquisitionOutcome)
    expect(await fixtures.liveLeases()).toHaveLength(1)
  })

  it('records the acquisition in the audit trail with the workflow that took it (FR-058)', async () => {
    const [workflowId] = await seedWorkflows(1, 'audited')
    const outcome = await acquireCredential({ db: fixtures.db(), workflowId })
    expect(outcome.outcome).toBe('acquired')
    const credentialId = outcome.outcome === 'acquired' ? outcome.agentCredentialId : ''

    const entries = await fixtures.auditFor(credentialId)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      entityType: 'agent_credential',
      entityId: credentialId,
      action: 'leased',
      // Null actor: the platform acted, not an administrator. SC-013 wants the acquisition
      // attributable to a *workflow*, which is what `detail` carries.
      actorUserId: null,
      detail: {
        workflowId,
        credentialGroupId: groupId,
        fence: outcome.outcome === 'acquired' ? outcome.fence : -1,
      },
    })
  })

  it('names the credential a workflow used on the workflow row, and leaves its state alone (FR-059)', async () => {
    const [workflowId] = await seedWorkflows(1, 'recorded')
    const outcome = await acquireCredential({ db: fixtures.db(), workflowId })
    const credentialId = outcome.outcome === 'acquired' ? outcome.agentCredentialId : ''

    const rows = await fixtures.db().execute<{
      agent_credential_id: string | null
      state: string
    }>(sql`select agent_credential_id, state from workflows where id = ${workflowId}`)
    expect([...rows][0]).toStrictEqual({ agent_credential_id: credentialId, state: 'queued' })
  })

  it('refuses a second seat to a workflow that already holds one (FR-015)', async () => {
    const [workflowId] = await seedWorkflows(1, 'greedy')
    const first = await acquireCredential({ db: fixtures.db(), workflowId })
    expect(first.outcome).toBe('acquired')

    const second = await acquireCredential({ db: fixtures.db(), workflowId })

    expect(second.outcome).toBe('already_held')
    expect(second).toMatchObject({
      agentCredentialId: first.outcome === 'acquired' ? first.agentCredentialId : '',
      leaseId: first.outcome === 'acquired' ? first.leaseId : '',
    })
    // Not a retry that quietly took a second identity: one lease, one seat.
    expect(await fixtures.liveLeases()).toHaveLength(1)
    expect(await fixtures.audit()).toHaveLength(1)
  })

  it('reaches no credential outside the workflow’s own attached groups (SC-016)', async () => {
    // Selection is where this is enforced and `select.test.ts` proves it exhaustively; asserted
    // again from the acquisition side because acquire is the caller that could bypass it.
    const unreachableGroup = await fixtures.seedGroup({ label: 'unreachable' })
    await fixtures.seedCredential({
      label: 'unreachable-seat',
      credentialGroupId: unreachableGroup,
      lastUsedAt: null,
    })
    const [workflowId] = await seedWorkflows(1, 'scoped')

    const outcome = await acquireCredential({ db: fixtures.db(), workflowId })
    expect(outcome.outcome).toBe('acquired')
    const credentialId = outcome.outcome === 'acquired' ? outcome.agentCredentialId : ''
    expect(credentialIds).toContain(credentialId)
  })

  describe('when a credential row and its live lease disagree', () => {
    /**
     * Drift: `agent_credentials.state = 'available'` while a live lease names the credential.
     *
     * Reachable — a forced release that fails partway, a manual repair, or the window the FR-022
     * sweep exists to close — and the one shape in which the conditional `UPDATE` cannot help:
     * the row *is* available, so the update matches, and the only thing standing between the second
     * workflow and a shared identity is `credential_leases_live_key`.
     */
    const seedDrift = async (): Promise<{
      readonly credentialId: string
      readonly incumbent: string
      readonly challenger: string
    }> => {
      const [incumbent, challenger] = await seedWorkflows(2, 'drift')
      // Only one seat reachable, so selection has no choice but the drifted one. Both statements
      // are needed and the order matters: an acquisition earlier in the same test may have left the
      // drifted credential `held`, and selection skipping it would produce `none_available` — a
      // pass that had never reached the guarantee under test.
      await fixtures
        .db()
        .execute(
          sql`update agent_credentials set state = 'available', held_by = null where credential_group_id = ${groupId}`,
        )
      await fixtures
        .db()
        .execute(
          sql`update agent_credentials set state = 'unhealthy' where credential_group_id = ${groupId} and id <> ${credentialIds[0]}`,
        )
      await fixtures.forceLease({
        agentCredentialId: credentialIds[0],
        workflowId: incumbent,
        fence: 1,
      })
      return { credentialId: credentialIds[0], incumbent, challenger }
    }

    it('refuses the second holder on the exclusivity index, and rolls the attempt back whole', async () => {
      const { credentialId, challenger } = await seedDrift()
      // Read rather than assumed: earlier tests in this file have already raised this credential's
      // fence, and the claim being made is that the refused attempt left it *unchanged* — asserting
      // a literal zero here would be asserting something about test order instead.
      const fenceBefore = (await fixtures.credential(credentialId))?.fence

      const outcome = await acquireCredential({
        db: fixtures.db(),
        workflowId: challenger,
        maxAttempts: 3,
      })

      // Not `acquired`, and not a throw: the pool would not settle, which is a state for the
      // caller to retry rather than an error to report.
      expect(outcome).toStrictEqual({
        outcome: 'contended',
        workflowId: challenger,
        attempts: 3,
      } satisfies AcquisitionOutcome)

      const live = await fixtures.liveLeases()
      expect(live).toHaveLength(1)
      expect(live[0]?.workflowId).not.toBe(challenger)

      // Everything the refused attempt did died with its transaction: the state change, the fence
      // increment, and above all the audit row. An audit write outside the transaction would have
      // left three entries here recording leases that never existed (FR-058, SC-013).
      const credential = await fixtures.credential(credentialId)
      expect(credential?.state).toBe('available')
      expect(credential?.fence).toBe(fenceBefore)
      expect(await fixtures.audit()).toStrictEqual([])
    })

    it('would hand out the seat twice if the exclusivity index were dropped', async () => {
      // **This test exists to prove the one above can fail.** The conditional update takes a row
      // lock, so in the ordinary race the index is never reached and dropping it would change
      // nothing that any other test here observes. Under drift it is the whole guarantee, and the
      // only way to know that is to take it away and watch two live leases appear on one identity.
      //
      // Safe because the database is this suite's own scratch database, created and dropped by the
      // fixture. The index is restored in `finally` regardless, so a failure inside the block
      // cannot leave the remaining tests running without the guarantee they are about.
      const { credentialId, challenger } = await seedDrift()

      try {
        await fixtures.execute(`drop index ${LEASE_EXCLUSIVITY_INDEX}`)

        const outcome = await acquireCredential({
          db: fixtures.db(),
          workflowId: challenger,
          maxAttempts: 3,
        })

        expect(outcome.outcome).toBe('acquired')
        const live = await fixtures.liveLeases()
        expect(live).toHaveLength(2)
        expect(live.filter((lease) => lease.agentCredentialId === credentialId)).toHaveLength(2)
      } finally {
        // The rows the missing index allowed have to go before it can exist again — `create unique
        // index` fails against data that violates it, which is itself a small proof that two live
        // leases on one credential really did land.
        await fixtures.clearLeases()
        await fixtures.execute(
          `create unique index ${LEASE_EXCLUSIVITY_INDEX} on credential_leases (agent_credential_id) where released_at is null`,
        )
      }

      // And with the index back, the same acquisition is refused again — so the restoration is
      // asserted rather than assumed, and the tests after this one are running under the guarantee.
      const { challenger: second } = await seedDrift()
      await expect(
        acquireCredential({ db: fixtures.db(), workflowId: second, maxAttempts: 2 }),
      ).resolves.toMatchObject({ outcome: 'contended' })
    })
  })
})
