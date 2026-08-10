import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { FakeSecretReader } from '../../aws'
import { createFakeSecretReader } from '../../aws'
import type { CredentialPoolFixtures } from '../allocate/pool-fixtures'
import { createCredentialPoolFixtures, readTestDatabaseUrl } from '../allocate/pool-fixtures'

import { acquireCredential } from './acquire'
import { isFenceCurrent, persistRotation, STALE_FENCE } from './fence'
import { releaseLease } from './release'

/**
 * **The fencing suite (T037) — FR-020, FR-031, FR-032, research R9.**
 *
 * The failure this exists to prevent is specific and does not look like a bug from inside the
 * process that causes it. A holder that has been force-released is not told; if it is partitioned
 * rather than dead it keeps working, keeps rotating, and keeps writing its copy of the material
 * over whatever is stored. The new holder's login is then quietly replaced by the old one's, and
 * the symptom arrives later as an authentication failure with nothing pointing at the cause.
 *
 * Lease expiry cannot fix that, because the displaced holder does not know it lost. The fence can,
 * because it is a fact about the credential rather than about who is alive: acquisition raises it,
 * the lease carries the value it was issued, and a write presenting anything lower is refused
 * without anyone having to decide whether the writer is still running.
 *
 * Two properties are load-bearing here and are asserted separately.
 *
 * 1. **A superseded write is refused and the newer material survives.** Refusing the write is only
 *    half of it — a refusal that had already overwritten the secret would satisfy a test that only
 *    checked the return value, so the stored material is read back every time.
 * 2. **The comparison consults the fence and nothing else.** In particular it does not ask whether
 *    the lease is still live or whether the workflow is still running, which is what makes FR-032
 *    fall out of the design rather than being a special case bolted onto it: a rotation that
 *    arrives after its run has terminated is *still the newest material there is*, and dropping it
 *    would leave the credential holding a copy the provider has already invalidated.
 */

const connectionString = readTestDatabaseUrl()

/** Distinguishable material, so a test that passed by writing the wrong value would not. */
const MATERIAL = {
  first: 'material-issued-at-fence-1',
  second: 'material-issued-at-fence-2',
  stale: 'material-a-partitioned-holder-still-thinks-is-current',
} as const

describe('the fence comparison', () => {
  // Pure, so it runs on a machine with no Postgres — the arithmetic of "is this write allowed" is
  // worth pinning independently of any row it will be applied to.
  it('accepts a write presenting the credential’s current fence', () => {
    expect(isFenceCurrent({ presentedFence: 7, currentFence: 7 })).toBe(true)
  })

  it('refuses a write presenting anything below it (FR-020)', () => {
    expect(isFenceCurrent({ presentedFence: 6, currentFence: 7 })).toBe(false)
    expect(isFenceCurrent({ presentedFence: 0, currentFence: 7 })).toBe(false)
  })

  it('accepts a fence above the current one rather than treating it as corruption', () => {
    // Unreachable in practice — only acquisition raises the fence, and it raises the credential's
    // copy first. Accepting it is still the right answer: the rule is "nothing *below* the current
    // value", and a holder that somehow presented a higher one is not the stale writer this guards
    // against. Refusing would turn an impossible state into a lost rotation.
    expect(isFenceCurrent({ presentedFence: 8, currentFence: 7 })).toBe(true)
  })

  it('names the refusal with one word, so callers do not match on prose', () => {
    expect(STALE_FENCE).toBe('stale_fence')
  })
})

describe.skipIf(connectionString === undefined)('persisting a rotation under a fence', () => {
  const url = connectionString ?? ''
  const fixtures: CredentialPoolFixtures = createCredentialPoolFixtures(url)

  let groupId = ''
  let profileId = ''
  let credentialId = ''
  const secretId = 'sisyphus/agent-credential/fence-suite'

  beforeAll(async () => {
    await fixtures.open()
    groupId = await fixtures.seedGroup({ label: 'fenced' })
    profileId = await fixtures.seedProfile({
      label: 'fenced',
      groups: [{ credentialGroupId: groupId, position: 1 }],
    })
  }, 120_000)

  // The same generous budget `beforeAll` gets, and for the mirror-image reason: `close()` issues
  // `drop database … with (force)` against a server several suites are concurrently creating and
  // dropping databases on, and the default ten seconds is a limit on the container rather than on
  // anything this suite does.
  afterAll(async () => {
    await fixtures.close()
  }, 120_000)

  beforeEach(async () => {
    // One credential in the group, and a fresh one each time. The tests below acquire through
    // `selectFor`, which picks the least-recently-used *available* credential — so a leftover from
    // an earlier test would be selected instead, and two acquisitions meant for one seat would land
    // on two, each at fence 1. That reads as "the fence did not advance" and would be a false
    // failure about the wrong thing.
    await fixtures.clearLeases()
    await fixtures
      .db()
      .execute(sql`delete from agent_credentials where credential_group_id = ${groupId}`)
    credentialId = await fixtures.seedCredential({
      label: 'fenced',
      credentialGroupId: groupId,
      secretId,
      fence: 0,
    })
  })

  const secretsHolding = (value: string): FakeSecretReader =>
    createFakeSecretReader({ [secretId]: value })

  it('accepts a write at the credential’s current fence and stores the material', async () => {
    const secrets = secretsHolding(MATERIAL.first)

    const outcome = await persistRotation({
      reader: fixtures.db(),
      secrets,
      agentCredentialId: credentialId,
      presentedFence: 0,
      material: MATERIAL.second,
    })

    expect(outcome).toStrictEqual({
      outcome: 'accepted',
      agentCredentialId: credentialId,
      presentedFence: 0,
      currentFence: 0,
    })
    expect(secrets.stored(secretId)).toBe(MATERIAL.second)
    expect(secrets.writes).toHaveLength(1)
  })

  it('refuses a superseded write, and the newer material survives it (FR-020, FR-031)', async () => {
    // The whole scenario, played out: one holder acquires, is force-released, a second holder
    // acquires and rotates, and then the first — still running somewhere, still believing it holds
    // the seat — writes its own copy.
    const displaced = await fixtures.seedWorkflow({
      label: 'displaced',
      executionProfileId: profileId,
      state: 'running',
    })
    const successor = await fixtures.seedWorkflow({
      label: 'successor',
      executionProfileId: profileId,
      state: 'running',
    })

    const first = await acquireCredential({ db: fixtures.db(), workflowId: displaced })
    expect(first.outcome).toBe('acquired')
    const displacedFence = first.outcome === 'acquired' ? first.fence : -1

    await releaseLease({ db: fixtures.db(), workflowId: displaced, reason: 'forced' })

    const second = await acquireCredential({ db: fixtures.db(), workflowId: successor })
    expect(second.outcome).toBe('acquired')
    const successorFence = second.outcome === 'acquired' ? second.fence : -1

    // Acquisition is what supersedes: the second holder's fence is strictly higher.
    expect(successorFence).toBeGreaterThan(displacedFence)

    const secrets = secretsHolding(MATERIAL.first)
    await persistRotation({
      reader: fixtures.db(),
      secrets,
      agentCredentialId: credentialId,
      presentedFence: successorFence,
      material: MATERIAL.second,
    })
    expect(secrets.stored(secretId)).toBe(MATERIAL.second)

    const refused = await persistRotation({
      reader: fixtures.db(),
      secrets,
      agentCredentialId: credentialId,
      presentedFence: displacedFence,
      material: MATERIAL.stale,
    })

    expect(refused).toStrictEqual({
      outcome: STALE_FENCE,
      agentCredentialId: credentialId,
      presentedFence: displacedFence,
      currentFence: successorFence,
    })
    // The refusal is worth nothing if the write had already landed. The newer material survives.
    expect(secrets.stored(secretId)).toBe(MATERIAL.second)
    expect(secrets.writes).toStrictEqual([{ secretId, value: MATERIAL.second }])
  })

  it('refuses the stale write without so much as touching the secret store', async () => {
    // Not a nicety: `SecretReader.write` versions the value in Secrets Manager, so a refusal that
    // wrote first and reported "stale" afterwards would leave the superseded material recoverable
    // as the newest version — and a rollback would restore the wrong login.
    // Raise the fence the way an acquisition would, without needing a workflow for it.
    await fixtures
      .db()
      .execute(sql`update agent_credentials set fence = 5 where id = ${credentialId}`)
    const secrets = secretsHolding(MATERIAL.second)

    const refused = await persistRotation({
      reader: fixtures.db(),
      secrets,
      agentCredentialId: credentialId,
      presentedFence: 4,
      material: MATERIAL.stale,
    })

    expect(refused.outcome).toBe(STALE_FENCE)
    expect(secrets.writes).toStrictEqual([])
    expect(secrets.stored(secretId)).toBe(MATERIAL.second)
  })

  it('accepts a rotation that arrives after its workflow has terminated (FR-032)', async () => {
    // The credential's future usability depends on this one. An agent that rotated its login on its
    // last turn produces material the platform has never stored; if the write were dropped because
    // the run had finished, the next holder would be issued a copy the provider has invalidated —
    // and the failure would look like a broken credential rather than a discarded rotation.
    const workflowId = await fixtures.seedWorkflow({
      label: 'terminated',
      executionProfileId: profileId,
      state: 'running',
    })

    const acquired = await acquireCredential({ db: fixtures.db(), workflowId })
    expect(acquired.outcome).toBe('acquired')
    const fence = acquired.outcome === 'acquired' ? acquired.fence : -1

    await releaseLease({ db: fixtures.db(), workflowId, reason: 'terminal' })

    const secrets = secretsHolding(MATERIAL.first)
    const outcome = await persistRotation({
      reader: fixtures.db(),
      secrets,
      agentCredentialId: credentialId,
      presentedFence: fence,
      material: MATERIAL.second,
    })

    expect(outcome.outcome).toBe('accepted')
    expect(secrets.stored(secretId)).toBe(MATERIAL.second)
  })

  it('decides on the fence alone, never on whether a lease is still live', async () => {
    // The previous test could pass for the wrong reason — a check on "does a lease exist" would
    // also accept while the row was still there. Here the lease is released *and* the credential is
    // back to `available` holding nobody, and the write is still accepted because its fence is
    // current. That is the property FR-032 actually needs.
    const workflowId = await fixtures.seedWorkflow({
      label: 'no-live-lease',
      executionProfileId: profileId,
      state: 'running',
    })
    const acquired = await acquireCredential({ db: fixtures.db(), workflowId })
    const fence = acquired.outcome === 'acquired' ? acquired.fence : -1
    await releaseLease({ db: fixtures.db(), workflowId, reason: 'terminal' })

    expect((await fixtures.liveLeases()).length).toBe(0)
    expect((await fixtures.credential(credentialId))?.state).toBe('available')

    await expect(
      persistRotation({
        reader: fixtures.db(),
        secrets: secretsHolding(MATERIAL.first),
        agentCredentialId: credentialId,
        presentedFence: fence,
        material: MATERIAL.second,
      }),
    ).resolves.toMatchObject({ outcome: 'accepted' })
  })

  it('refuses to write to a credential that has no secret to write to (FR-008)', async () => {
    const awaitingLogin = await fixtures.seedCredential({
      label: 'no-material-yet',
      credentialGroupId: groupId,
      state: 'awaiting_login',
      secretId: null,
    })

    await expect(
      persistRotation({
        reader: fixtures.db(),
        secrets: secretsHolding(MATERIAL.first),
        agentCredentialId: awaitingLogin,
        presentedFence: 0,
        material: MATERIAL.second,
      }),
    ).rejects.toThrow(/secret/i)
  })

  it('refuses a rotation for a credential that does not exist', async () => {
    // The caller and the database disagree about what exists. Creating the secret here would file
    // material under an identifier no credential references, and report success for it.
    await expect(
      persistRotation({
        reader: fixtures.db(),
        secrets: secretsHolding(MATERIAL.first),
        agentCredentialId: '00000000-0000-7000-8000-000000000000',
        presentedFence: 0,
        material: MATERIAL.second,
      }),
    ).rejects.toThrow(/does not exist/i)
  })

  it('never returns the material it was handed, in either outcome', async () => {
    // SC-014: nothing that carries material may reach a log, and an outcome object is one `console`
    // call away from being one. Asserted structurally rather than trusted.
    const accepted = await persistRotation({
      reader: fixtures.db(),
      secrets: secretsHolding(MATERIAL.first),
      agentCredentialId: credentialId,
      presentedFence: 0,
      material: MATERIAL.second,
    })

    expect(JSON.stringify(accepted)).not.toContain(MATERIAL.second)
    expect(Object.keys(accepted).sort()).toStrictEqual([
      'agentCredentialId',
      'currentFence',
      'outcome',
      'presentedFence',
    ])
  })
})
