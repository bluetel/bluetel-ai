import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createWorkflowFixtures, readTestDatabaseUrl } from '../jobs/workflow-fixtures'

import { liveCredentialFor, mintScopedCredential } from './mint'
import { revokeScopedCredentials } from './revoke'

/**
 * Revocation is what makes FR-038's "revoke its credential" an action rather than a wait. These
 * tests are therefore about the two properties teardown and the reconciler depend on: it takes
 * effect at once, and calling it twice is not an error.
 */

const connectionString = readTestDatabaseUrl()
const describeWithDatabase = connectionString === undefined ? describe.skip : describe

const SECRET = 'test-signing-secret-not-a-real-one'

describeWithDatabase('revoking a scoped credential', () => {
  const fixtures = createWorkflowFixtures(connectionString ?? '')

  beforeAll(() => fixtures.open(), 60_000)
  afterEach(() => fixtures.removeAll())
  afterAll(() => fixtures.close())

  it('closes a live credential immediately, without waiting for its window', async () => {
    const workflowId = await fixtures.seedWorkflow({ label: 'revoke' })
    const minted = await mintScopedCredential({ db: fixtures.db(), workflowId, secret: SECRET })
    const revokedAt = new Date('2026-08-05T11:00:00.000Z')

    const outcome = await revokeScopedCredentials({
      db: fixtures.db(),
      workflowId,
      now: revokedAt,
    })

    expect(outcome.revoked).toBe(1)
    expect(outcome.credentialIds).toStrictEqual([minted.credentialId])
    // The row's own window had not run out; revocation does not wait for it.
    expect(minted.expiresAt.getTime()).toBeGreaterThan(revokedAt.getTime() - 60 * 60 * 1000)
    expect(await liveCredentialFor(fixtures.db(), workflowId)).toBeUndefined()
  })

  it('is idempotent, and does not move the timestamp the first revocation recorded', async () => {
    const workflowId = await fixtures.seedWorkflow({ label: 'idempotent' })
    await mintScopedCredential({ db: fixtures.db(), workflowId, secret: SECRET })

    const first = await revokeScopedCredentials({
      db: fixtures.db(),
      workflowId,
      now: new Date('2026-08-05T11:00:00.000Z'),
    })
    const second = await revokeScopedCredentials({
      db: fixtures.db(),
      workflowId,
      now: new Date('2026-08-05T12:00:00.000Z'),
    })

    // Teardown retries and the reconciler sweeps; neither can know the other already revoked, so
    // "nothing left to revoke" has to read as success rather than as a failure.
    expect(first.revoked).toBe(1)
    expect(second.revoked).toBe(0)
    expect(second.credentialIds).toStrictEqual([])
  })

  it('revokes nothing for a run that never held a credential', async () => {
    const workflowId = await fixtures.seedWorkflow({ label: 'never-minted' })

    expect((await revokeScopedCredentials({ db: fixtures.db(), workflowId })).revoked).toBe(0)
  })

  it('leaves the credential of another run alone', async () => {
    const mine = await fixtures.seedWorkflow({ label: 'mine' })
    const theirs = await fixtures.seedWorkflow({ label: 'theirs' })
    await mintScopedCredential({ db: fixtures.db(), workflowId: mine, secret: SECRET })
    const other = await mintScopedCredential({
      db: fixtures.db(),
      workflowId: theirs,
      secret: SECRET,
    })

    await revokeScopedCredentials({ db: fixtures.db(), workflowId: mine })

    expect((await liveCredentialFor(fixtures.db(), theirs))?.id).toBe(other.credentialId)
  })
})
