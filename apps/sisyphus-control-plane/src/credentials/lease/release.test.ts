import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { CredentialPoolFixtures } from '../allocate/pool-fixtures'
import { createCredentialPoolFixtures, readTestDatabaseUrl } from '../allocate/pool-fixtures'

import { acquireCredential } from './acquire'
import { releaseLease } from './release'

/**
 * **Releasing a seat (T043) — FR-019, FR-058, and the rule that release is not a repair.**
 *
 * The rule with teeth here is the last one. A credential that went `cooling_off` or `unhealthy`
 * while it was held must come back to *that* state, not to `available`. It is easy to write the
 * opposite by accident — `SET state = 'available'` is the obvious statement, and it is right in the
 * ordinary case — and the consequence is not a cosmetic one: a credential the provider is rate
 * limiting, or whose login is broken, would be handed straight to the next workflow that asked, and
 * that workflow would fail for a reason nothing in its own history explains. FR-033 and SC-010 both
 * fall to it. So the conditional is asserted here from every state a held credential can be in, not
 * only from the one the happy path uses.
 *
 * The rest is bookkeeping that has to be exact: the lease carries its reason, the audit trail
 * distinguishes a seat given back from a seat taken away, and an administrator who took one is
 * named while the reconciliation sweep is not (SC-015).
 */

const connectionString = readTestDatabaseUrl()

describe.skipIf(connectionString === undefined)('releasing a credential lease', () => {
  const url = connectionString ?? ''
  const fixtures: CredentialPoolFixtures = createCredentialPoolFixtures(url)

  let groupId = ''
  let profileId = ''
  let credentialId = ''

  beforeAll(async () => {
    await fixtures.open()
    groupId = await fixtures.seedGroup({ label: 'released' })
    profileId = await fixtures.seedProfile({
      label: 'released',
      groups: [{ credentialGroupId: groupId, position: 1 }],
    })
    credentialId = await fixtures.seedCredential({ label: 'the-seat', credentialGroupId: groupId })
  }, 120_000)

  // The same generous budget `beforeAll` gets, and for the mirror-image reason: `close()` issues
  // `drop database … with (force)` against a server several suites are concurrently creating and
  // dropping databases on, and the default ten seconds is a limit on the container rather than on
  // anything this suite does.
  afterAll(async () => {
    await fixtures.close()
  }, 120_000)

  afterEach(async () => {
    await fixtures.clearLeases()
    await fixtures
      .db()
      .execute(
        sql`update agent_credentials set state = 'available', held_by = null where id = ${credentialId}`,
      )
  })

  /** A workflow holding the one seat, as admission would have left it. */
  const holding = async (label: string): Promise<string> => {
    const workflowId = await fixtures.seedWorkflow({
      label,
      executionProfileId: profileId,
      state: 'running',
    })
    const outcome = await acquireCredential({ db: fixtures.db(), workflowId })
    expect(outcome.outcome).toBe('acquired')
    return workflowId
  }

  const forceState = async (state: string): Promise<void> => {
    await fixtures
      .db()
      .execute(
        sql`update agent_credentials set state = ${state}::credential_state where id = ${credentialId}`,
      )
  }

  it('ends the lease, frees the seat and records the reason (FR-019)', async () => {
    const workflowId = await holding('terminal')

    const outcome = await releaseLease({ db: fixtures.db(), workflowId, reason: 'terminal' })

    expect(outcome).toMatchObject({
      outcome: 'released',
      workflowId,
      agentCredentialId: credentialId,
      reason: 'terminal',
      credentialState: 'available',
    })

    const [lease] = await fixtures.leases()
    expect(lease.releasedAt).not.toBeNull()
    expect(lease.releaseReason).toBe('terminal')
    expect(lease.releasedByUserId).toBeNull()

    const credential = await fixtures.credential(credentialId)
    expect(credential?.state).toBe('available')
    expect(credential?.heldBy).toBeNull()
  })

  it('leaves the workflow’s record naming the credential it used (FR-059)', async () => {
    // The lease says who held a seat; this column says what the run charged to it, and it is what
    // per-credential spend joins on. Clearing it on release would erase the run's own history.
    const workflowId = await holding('recorded')
    await releaseLease({ db: fixtures.db(), workflowId, reason: 'terminal' })

    const rows = await fixtures.db().execute<{
      agent_credential_id: string | null
    }>(sql`select agent_credential_id from workflows where id = ${workflowId}`)
    expect([...rows][0]?.agent_credential_id).toBe(credentialId)
  })

  it('frees the seat for the next workflow', async () => {
    const first = await holding('first')
    await releaseLease({ db: fixtures.db(), workflowId: first, reason: 'terminal' })

    const second = await fixtures.seedWorkflow({
      label: 'second',
      executionProfileId: profileId,
      state: 'queued',
    })
    await expect(
      acquireCredential({ db: fixtures.db(), workflowId: second }),
    ).resolves.toMatchObject({ outcome: 'acquired', agentCredentialId: credentialId })
  })

  it.each(['cooling_off', 'unhealthy'] as const)(
    'returns a credential that went %s while held to that state, not to available',
    async (state) => {
      // **Release is not a repair.** FR-077 has a run wait out a cooling-off and FR-023 fails a run
      // whose credential broke rather than substituting another — in both cases the lease then
      // releases through the ordinary terminal path, and in both cases handing the credential
      // straight back to the pool would pass the problem to the next workflow.
      const workflowId = await holding(`held-then-${state}`)
      await forceState(state)

      const outcome = await releaseLease({ db: fixtures.db(), workflowId, reason: 'terminal' })

      expect(outcome).toMatchObject({ outcome: 'released', credentialState: state })
      const credential = await fixtures.credential(credentialId)
      expect(credential?.state).toBe(state)
      // Nobody holds it any more, whatever state it is in — the holder discriminator is about a
      // live claim, and leaving it set would show a finished run against the seat in the pool view.
      expect(credential?.heldBy).toBeNull()
    },
  )

  it('returns a credential disabled while held to disabled, so FR-006 survives the run ending', async () => {
    const workflowId = await holding('held-then-disabled')
    await forceState('disabled')

    await releaseLease({ db: fixtures.db(), workflowId, reason: 'terminal' })

    expect((await fixtures.credential(credentialId))?.state).toBe('disabled')
  })

  it('still ends the lease when it does not free the seat', async () => {
    // The two halves are independent: a credential that stays `cooling_off` is not held by anybody,
    // and a lease left live because the credential was unwell would strand the seat forever.
    const workflowId = await holding('lease-ends-anyway')
    await forceState('cooling_off')

    await releaseLease({ db: fixtures.db(), workflowId, reason: 'terminal' })

    expect(await fixtures.liveLeases()).toStrictEqual([])
  })

  it('records a released entry carrying its reason (FR-058)', async () => {
    const workflowId = await holding('audited')
    await releaseLease({ db: fixtures.db(), workflowId, reason: 'terminal' })

    const entries = await fixtures.auditFor(credentialId)
    expect(entries.map((entry) => entry.action)).toStrictEqual(['leased', 'released'])
    expect(entries[1]).toMatchObject({
      entityType: 'agent_credential',
      action: 'released',
      actorUserId: null,
      detail: { workflowId, releaseReason: 'terminal', credentialState: 'available' },
    })
  })

  it('records a forced release as a different event, attributed to the administrator (FR-057, SC-015)', async () => {
    // `released` and `force_released` are distinct for the same reason `replaced` is distinct from
    // `updated`: "was anything taken off a run?" is the first question asked after a run ends
    // unexpectedly, and a trail that spelled both the same way could not answer it.
    const workflowId = await holding('seized')
    const administrator = fixtures.ownerUserId()

    const outcome = await releaseLease({
      db: fixtures.db(),
      workflowId,
      reason: 'forced',
      releasedByUserId: administrator,
    })

    expect(outcome).toMatchObject({ outcome: 'released', reason: 'forced' })
    const [lease] = await fixtures.leases()
    expect(lease.releaseReason).toBe('forced')
    expect(lease.releasedByUserId).toBe(administrator)

    const entries = await fixtures.auditFor(credentialId)
    expect(entries.map((entry) => entry.action)).toStrictEqual(['leased', 'force_released'])
    expect(entries[1]?.actorUserId).toBe(administrator)
  })

  it('leaves released_by_user_id null when the platform forced it rather than a person (SC-015)', async () => {
    // The FR-022 sweep also records `forced`. The null is what distinguishes an administrator
    // seizing a seat from the platform tidying up after a run that no longer exists.
    const workflowId = await holding('swept')

    await releaseLease({ db: fixtures.db(), workflowId, reason: 'forced' })

    const [lease] = await fixtures.leases()
    expect(lease.releaseReason).toBe('forced')
    expect(lease.releasedByUserId).toBeNull()
  })

  it('raises the fence on nothing — only acquisition does that (R9)', async () => {
    // Worth pinning: a release that bumped the fence would invalidate a rotation the departing
    // holder had already sent and not yet had persisted, and FR-032 says that write must land.
    const workflowId = await holding('fence-untouched')
    const before = (await fixtures.credential(credentialId))?.fence

    await releaseLease({ db: fixtures.db(), workflowId, reason: 'terminal' })

    expect((await fixtures.credential(credentialId))?.fence).toBe(before)
  })

  it('says so, and writes nothing, when the workflow holds no live lease', async () => {
    const workflowId = await fixtures.seedWorkflow({
      label: 'never-held',
      executionProfileId: profileId,
      state: 'failed',
    })

    await expect(
      releaseLease({ db: fixtures.db(), workflowId, reason: 'terminal' }),
    ).resolves.toStrictEqual({ outcome: 'not_held', workflowId })
    expect(await fixtures.audit()).toStrictEqual([])
  })

  it('is idempotent, so a retried teardown does not write a second release', async () => {
    // Teardown is a job and jobs are retried. A second release that appended another audit row —
    // or, worse, freed a seat some other run had since taken — would be a defect visible only under
    // retry, which is where nobody is looking.
    const workflowId = await holding('retried')
    await releaseLease({ db: fixtures.db(), workflowId, reason: 'terminal' })

    await expect(
      releaseLease({ db: fixtures.db(), workflowId, reason: 'terminal' }),
    ).resolves.toStrictEqual({ outcome: 'not_held', workflowId })

    expect(await fixtures.leases()).toHaveLength(1)
    expect((await fixtures.auditFor(credentialId)).map((entry) => entry.action)).toStrictEqual([
      'leased',
      'released',
    ])
  })
})
