import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { FakeSecretReader } from '../../aws'
import { createFakeSecretReader } from '../../aws'
import type { CredentialPoolFixtures } from '../allocate/pool-fixtures'
import { createCredentialPoolFixtures, readTestDatabaseUrl } from '../allocate/pool-fixtures'

import type { LoginMaterialSource } from './capture'
import { captureLoginMaterial, loginSecretName } from './capture'

/**
 * Capturing a login's material (T076, FR-008, FR-070, FR-072).
 *
 * Against a real database, because everything worth asserting here is a claim about a row: that a
 * first login creates a secret and records its identifier, that every later one goes down the
 * shared rotation path instead, and that a seat which moved while the login was in flight is not
 * overwritten. None of those can be settled by a mock of the query builder.
 *
 * **The property with the most riding on it is the last section.** A successful capture must leave
 * no trace of the material anywhere except Secrets Manager — not in the outcome, not in the
 * credential row, not in the audit trail. It is asserted by searching, with material that is
 * genuinely in the store at the time, rather than by checking that a field nobody wrote is absent.
 */

const connectionString = readTestDatabaseUrl()

const MATERIAL = 'sk-login-material-0001'
const ROTATED = 'sk-login-material-0002'

const SECRET_PREFIX = 'sisyphus/test/agent-credential'

/** A material source that answers whatever has been put in it, and `undefined` before that. */
const materialSource = (): LoginMaterialSource & {
  readonly write: (value: string | undefined) => void
  readonly reads: readonly string[]
} => {
  const reads: string[] = []
  let value: string | undefined

  return {
    reads,
    write: (next) => {
      value = next
    },
    read: (input) => {
      reads.push(input.environmentId)
      return Promise.resolve(value)
    },
  }
}

describe.skipIf(connectionString === undefined)('captureLoginMaterial', () => {
  const fixtures: CredentialPoolFixtures = createCredentialPoolFixtures(connectionString ?? '')

  let groupId: string
  const secrets: FakeSecretReader = createFakeSecretReader()

  beforeAll(async () => {
    await fixtures.open()
    groupId = await fixtures.seedGroup({ label: 'capture' })
  }, 120_000)

  afterAll(async () => {
    await fixtures.close()
  }, 30_000)

  const awaitingLogin = async (label: string): Promise<string> =>
    fixtures.seedCredential({
      label,
      credentialGroupId: groupId,
      state: 'awaiting_login',
      secretId: null,
    })

  const capture = async (agentCredentialId: string, materials: LoginMaterialSource) =>
    captureLoginMaterial({
      db: fixtures.db(),
      materials,
      secrets,
      agentCredentialId,
      environmentId: 'i-login-1',
      secretNamePrefix: SECRET_PREFIX,
    })

  it('answers not_ready while the administrator is still typing', async () => {
    const credentialId = await awaitingLogin('capture-not-ready')
    const materials = materialSource()

    const outcome = await capture(credentialId, materials)

    // The ordinary answer for most of a login's life, and deliberately not an error: the caller
    // polls until the material appears or the deadline passes.
    expect(outcome).toStrictEqual({ outcome: 'not_ready', agentCredentialId: credentialId })
    expect(materials.reads).toStrictEqual(['i-login-1'])
    expect((await fixtures.credential(credentialId))?.state).toBe('awaiting_login')
  })

  it('creates the seat’s secret on first login and records the identifier the store resolved', async () => {
    const credentialId = await awaitingLogin('capture-first')
    const materials = materialSource()
    materials.write(MATERIAL)

    const outcome = await capture(credentialId, materials)

    expect(outcome).toMatchObject({ outcome: 'captured', createdSecret: true })

    const credential = await fixtures.credential(credentialId)
    // The store's identifier, not a name this module rebuilt: real Secrets Manager appends six
    // random characters, so a caller that reconstructed one would be asserting something untrue.
    expect(credential?.secretId).toBe(secrets.creations[0]?.secretId)
    expect(secrets.creations[0]?.name).toBe(loginSecretName(SECRET_PREFIX, credentialId))
    expect(secrets.stored(credential?.secretId ?? '')).toBe(MATERIAL)

    // And only now is the seat usable (FR-008).
    expect(credential?.state).toBe('available')
    expect(credential?.lastLoginAt).not.toBeNull()
  })

  it('never captures twice into a seat that already works', async () => {
    const credentialId = await awaitingLogin('capture-repeat')
    const materials = materialSource()
    materials.write(MATERIAL)
    await capture(credentialId, materials)

    const secretId = (await fixtures.credential(credentialId))?.secretId ?? ''
    const creationsBefore = secrets.creations.length

    materials.write(ROTATED)
    const outcome = await captureLoginMaterial({
      db: fixtures.db(),
      materials,
      secrets,
      agentCredentialId: credentialId,
      environmentId: 'i-login-2',
      secretNamePrefix: SECRET_PREFIX,
    })

    // The seat is `available` after the first capture, and `available` is not a state a login
    // completes from: replacing material the pool is about to hand out, on the strength of an
    // environment somebody left open, is exactly what the state condition is for.
    expect(outcome).toMatchObject({ outcome: 'refused' })
    expect(secrets.creations).toHaveLength(creationsBefore)
    expect(secrets.stored(secretId)).toBe(MATERIAL)
  })

  /**
   * **The T076 assertion.** A re-login does not write to Secrets Manager by its own route. It calls
   * the same `persistRotation` a rotation calls, so the fence rule holds for a login for free and a
   * change to how rotations are stored cannot leave logins behind.
   */
  it('stores a re-login into the existing secret, through the rotation path', async () => {
    // The seat already points at a secret the store knows about, as a real re-login's would. The
    // identifier comes from the store rather than being composed here: real Secrets Manager
    // appends six random characters, so a test that rebuilt one would assert something untrue.
    const secretId = await secrets.create('sisyphus/test/capture-unhealthy', MATERIAL)
    const credentialId = await fixtures.seedCredential({
      label: 'capture-unhealthy',
      credentialGroupId: groupId,
      state: 'unhealthy',
      fence: 3,
      secretId,
    })

    const materials = materialSource()
    materials.write(ROTATED)

    const outcome = await captureLoginMaterial({
      db: fixtures.db(),
      materials,
      secrets,
      agentCredentialId: credentialId,
      environmentId: 'i-login-3',
      secretNamePrefix: SECRET_PREFIX,
    })

    expect(outcome).toMatchObject({ outcome: 'captured', createdSecret: false })
    // One secret, a new value in it. `persistRotation` did the write — `writes` is its record, and
    // a login that had gone around it would show up as a `create` instead.
    expect(secrets.writes.at(-1)).toMatchObject({ value: ROTATED })
    expect((await fixtures.credential(credentialId))?.state).toBe('available')
  })

  it('refuses to capture into a seat that moved while the login was in flight', async () => {
    const credentialId = await fixtures.seedCredential({
      label: 'capture-held',
      credentialGroupId: groupId,
      state: 'held',
    })
    const materials = materialSource()
    materials.write(ROTATED)

    const outcome = await capture(credentialId, materials)

    // A capture into a `held` seat would replace the material a run is currently authenticated
    // with, mid-flight, with nothing to tell it why its next call failed.
    expect(outcome).toMatchObject({ outcome: 'refused' })
    expect(materials.reads).toStrictEqual([])
    expect((await fixtures.credential(credentialId))?.state).toBe('held')
  })

  it('fails loudly for a seat this database has never had', async () => {
    const materials = materialSource()
    materials.write(MATERIAL)

    await expect(capture('018f1a2b-0000-7000-8000-0000000000ff', materials)).rejects.toThrow(
      /does not exist/,
    )
  })

  /**
   * FR-070 and SC-014, asserted against material that is genuinely in the store at the time. An
   * outcome object is one `console` call away from being a log line.
   */
  it('leaves the material in exactly one place, and it is not anywhere a reader can reach', async () => {
    const credentialId = await awaitingLogin('capture-no-echo')
    const materials = materialSource()
    materials.write(MATERIAL)

    const outcome = await capture(credentialId, materials)

    expect(JSON.stringify(outcome)).not.toContain(MATERIAL)

    // Not in the row, either — `agent_credentials` holds an identifier and never a value (FR-011).
    const credential = await fixtures.credential(credentialId)
    expect(JSON.stringify(credential)).not.toContain(MATERIAL)

    // Nor in the trail this seat carries.
    expect(JSON.stringify(await fixtures.auditFor(credentialId))).not.toContain(MATERIAL)

    // And it *is* in the store, so the assertions above are about material that exists.
    expect(secrets.stored(credential?.secretId ?? '')).toBe(MATERIAL)
  })
})

describe('loginSecretName', () => {
  it('files a seat under its id rather than its name', () => {
    // A name is administrator-chosen and may be changed; the id may not be. A secret whose name stopped
    // matching its seat after a rename would be findable by nobody.
    expect(loginSecretName('sisyphus/agent-credential', 'credential-1')).toBe(
      'sisyphus/agent-credential/credential-1',
    )
  })

  it('does not double the separator when the prefix already ends in one', () => {
    expect(loginSecretName('sisyphus/agent-credential/', 'credential-1')).toBe(
      'sisyphus/agent-credential/credential-1',
    )
  })
})
