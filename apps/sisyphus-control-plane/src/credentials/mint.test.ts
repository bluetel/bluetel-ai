import type { ValidationCredential } from '@bluetel-ai/sisyphus-api/db'
import { scopedCredentials, validationCredentials } from '@bluetel-ai/sisyphus-api/db'
import {
  credentialSigningKey,
  SCOPED_CREDENTIAL_AUDIENCE,
  SCOPED_CREDENTIAL_ISSUER,
  SCOPED_CREDENTIAL_MAX_LIFETIME_MS,
  SCOPED_CREDENTIAL_WINDOW_MS,
} from '@bluetel-ai/sisyphus-api/server'
import { and, eq, isNull } from 'drizzle-orm'
import { decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

// The fixture harness is deliberately absent from `jobs/index.ts` — exporting a seeder from a
// barrel would put it one import away from a job — so a test reaches the module directly. That is
// the only sanctioned way in, and it is why this import looks like a barrel violation and is not.
import type { WorkflowFixtures } from '../jobs/workflow-fixtures'
import { createWorkflowFixtures, readTestDatabaseUrl } from '../jobs/workflow-fixtures'

import { liveCredentialFor, mintScopedCredential, mintValidationCredential } from './mint'

/**
 * FR-037 has three parts, and each one is a test here: **short-lived** (the row's window, not the
 * token's ceiling), **one workflow** (the subject, which cannot name two), and **machine surface
 * only** (the audience).
 *
 * The fourth property is the one a naive mint would miss: a second mint for the same run must
 * supersede the first rather than lose on `scoped_credentials_live_key`, and the superseded token
 * must stop working immediately.
 */

const connectionString = readTestDatabaseUrl()
const describeWithDatabase = connectionString === undefined ? describe.skip : describe

const SECRET = 'test-signing-secret-not-a-real-one'

describeWithDatabase('minting a workflow-scoped credential', () => {
  const fixtures = createWorkflowFixtures(connectionString ?? '')

  beforeAll(() => fixtures.open(), 60_000)
  afterEach(() => fixtures.removeAll())
  afterAll(() => fixtures.close())

  it('writes a row and returns a token backed by it', async () => {
    const workflowId = await fixtures.seedWorkflow({ label: 'mint' })
    const issuedAt = new Date('2026-08-05T10:00:00.000Z')

    const minted = await mintScopedCredential({
      db: fixtures.db(),
      workflowId,
      secret: SECRET,
      now: issuedAt,
    })

    const stored = await liveCredentialFor(fixtures.db(), workflowId)

    expect(stored).toBeDefined()
    expect(stored?.id).toBe(minted.credentialId)
    expect(stored?.jti).toBe(minted.jti)
    expect(stored?.revokedAt).toBeNull()
    expect(stored?.renewalCount).toBe(0)
  })

  it('scopes the token to one workflow and to the machine surface', async () => {
    const workflowId = await fixtures.seedWorkflow({ label: 'claims' })

    const minted = await mintScopedCredential({ db: fixtures.db(), workflowId, secret: SECRET })
    const { payload } = await jwtVerify(minted.token, credentialSigningKey(SECRET), {
      issuer: SCOPED_CREDENTIAL_ISSUER,
      audience: SCOPED_CREDENTIAL_AUDIENCE,
    })

    expect(payload.sub).toBe(`workflow:${workflowId}`)
    expect(payload.aud).toBe(SCOPED_CREDENTIAL_AUDIENCE)
    expect(payload.jti).toBe(minted.jti)
    expect(decodeProtectedHeader(minted.token).alg).toBe('HS256')
  })

  it('carries no claim that could name a second workflow', async () => {
    const workflowId = await fixtures.seedWorkflow({ label: 'no-widening' })

    const minted = await mintScopedCredential({ db: fixtures.db(), workflowId, secret: SECRET })
    const payload = decodeJwt(minted.token)

    // The full claim set, enumerated. A `scope`, `workflows` or `permissions` claim appearing here
    // later would be a widening the format currently cannot express, and this test is what makes
    // adding one a deliberate act rather than an incidental one.
    expect(Object.keys(payload).sort()).toStrictEqual([
      'aud',
      'cid',
      'exp',
      'iat',
      'iss',
      'jti',
      'nbf',
      'sub',
    ])
    expect(JSON.stringify(payload)).not.toContain('[')
  })

  it('expires the row short and the token long, with the row governing', async () => {
    const workflowId = await fixtures.seedWorkflow({ label: 'windows' })
    const issuedAt = new Date('2026-08-05T10:00:00.000Z')

    const minted = await mintScopedCredential({
      db: fixtures.db(),
      workflowId,
      secret: SECRET,
      now: issuedAt,
    })

    expect(minted.expiresAt.getTime()).toBe(issuedAt.getTime() + SCOPED_CREDENTIAL_WINDOW_MS)

    const payload = decodeJwt(minted.token)
    expect(payload.exp).toBe(
      Math.floor((issuedAt.getTime() + SCOPED_CREDENTIAL_MAX_LIFETIME_MS) / 1000),
    )
    // The token's ceiling is not the credential's life. `machineProcedure` reads the row.
    expect((payload.exp ?? 0) * 1000).toBeGreaterThan(minted.expiresAt.getTime())
  })

  it('gives every issue a fresh jti, so a replay is recognisable rather than merely unexpired', async () => {
    const workflowId = await fixtures.seedWorkflow({ label: 'jti' })

    const first = await mintScopedCredential({ db: fixtures.db(), workflowId, secret: SECRET })
    const second = await mintScopedCredential({ db: fixtures.db(), workflowId, secret: SECRET })

    expect(second.jti).not.toBe(first.jti)
    expect(second.credentialId).not.toBe(first.credentialId)
  })

  it('supersedes the incumbent rather than losing on the live-credential index', async () => {
    const workflowId = await fixtures.seedWorkflow({ label: 'supersede' })

    const first = await mintScopedCredential({ db: fixtures.db(), workflowId, secret: SECRET })
    const second = await mintScopedCredential({ db: fixtures.db(), workflowId, secret: SECRET })

    expect(second.supersededCredentialId).toBe(first.credentialId)

    const rows = await fixtures
      .db()
      .select()
      .from(scopedCredentials)
      .where(eq(scopedCredentials.workflowId, workflowId))

    expect(rows).toHaveLength(2)
    expect(rows.filter((row) => row.revokedAt === null)).toHaveLength(1)
    // The re-provision path — a resume, or a retried hand-off after a launch failure — must not
    // fail on an index for something entirely ordinary.
    expect((await liveCredentialFor(fixtures.db(), workflowId))?.id).toBe(second.credentialId)
  })

  it('reports no supersession on a first mint', async () => {
    const workflowId = await fixtures.seedWorkflow({ label: 'first-mint' })

    const minted = await mintScopedCredential({ db: fixtures.db(), workflowId, secret: SECRET })

    expect(minted.supersededCredentialId).toBeUndefined()
  })

  it('refuses to sign with an empty secret, before any row exists', async () => {
    const workflowId = await fixtures.seedWorkflow({ label: 'empty-secret' })

    await expect(
      mintScopedCredential({ db: fixtures.db(), workflowId, secret: '' }),
    ).rejects.toThrow(/empty/)
  })
})

/**
 * The validation half (T200, FR-147).
 *
 * This suite used to assert the opposite of what it asserts now, and the change is the task: a
 * validation token was signed and backed by **no row**, because `scoped_credentials.workflow_id` is
 * `not null` and a validation run has no workflow. `validation_credentials` supplies the row without
 * touching that column or its index, so the same four FR-037 properties now hold for a validation
 * credential as for a workflow one — and the fifth, supersession, holds for the same reason.
 */
describeWithDatabase('minting a validation-run credential', () => {
  const fixtures = createWorkflowFixtures(connectionString ?? '')

  beforeAll(() => fixtures.open(), 60_000)
  afterEach(() => fixtures.removeAll())
  afterAll(() => fixtures.close())

  it('writes a row and returns a token backed by it', async () => {
    const validationRunId = await fixtures.seedValidationRun()
    const issuedAt = new Date('2026-08-05T10:00:00.000Z')

    const minted = await mintValidationCredential({
      db: fixtures.db(),
      validationRunId,
      secret: SECRET,
      now: issuedAt,
    })

    const stored = await liveValidationCredentialFor(fixtures.db(), validationRunId)

    expect(stored).toBeDefined()
    expect(stored?.id).toBe(minted.credentialId)
    expect(stored?.jti).toBe(minted.jti)
    expect(stored?.revokedAt).toBeNull()
    expect(stored?.renewalCount).toBe(0)
    expect(minted.supersededCredentialId).toBeUndefined()
  })

  it('signs a subject in the validation space, and nothing that could name a workflow', async () => {
    const validationRunId = await fixtures.seedValidationRun()

    const minted = await mintValidationCredential({
      db: fixtures.db(),
      validationRunId,
      secret: SECRET,
    })
    const { payload } = await jwtVerify(minted.token, credentialSigningKey(SECRET), {
      issuer: SCOPED_CREDENTIAL_ISSUER,
      audience: SCOPED_CREDENTIAL_AUDIENCE,
    })

    expect(payload.sub).toBe(`validation:${validationRunId}`)
    expect(payload.aud).toBe(SCOPED_CREDENTIAL_AUDIENCE)
    expect(payload.cid).toBe(minted.credentialId)
    // The same enumeration `mintScopedCredential`'s claims get, for the same reason: a `scope` or
    // `workflows` claim appearing here would be a widening the format cannot currently express.
    expect(Object.keys(payload).sort()).toStrictEqual([
      'aud',
      'cid',
      'exp',
      'iat',
      'iss',
      'jti',
      'nbf',
      'sub',
    ])
  })

  it('expires the row short and the token long, with the row governing', async () => {
    const validationRunId = await fixtures.seedValidationRun()
    const issuedAt = new Date('2026-08-05T10:00:00.000Z')

    const minted = await mintValidationCredential({
      db: fixtures.db(),
      validationRunId,
      secret: SECRET,
      now: issuedAt,
    })

    expect(minted.expiresAt.getTime()).toBe(issuedAt.getTime() + SCOPED_CREDENTIAL_WINDOW_MS)
    expect((decodeJwt(minted.token).exp ?? 0) * 1000).toBe(
      Math.floor(issuedAt.getTime() + SCOPED_CREDENTIAL_MAX_LIFETIME_MS),
    )
  })

  it('supersedes the incumbent rather than losing on validation_credentials_live_key', async () => {
    // A launch that failed after the row was written and is retried arrives here twice for one run.
    const validationRunId = await fixtures.seedValidationRun()

    const first = await mintValidationCredential({
      db: fixtures.db(),
      validationRunId,
      secret: SECRET,
    })
    const second = await mintValidationCredential({
      db: fixtures.db(),
      validationRunId,
      secret: SECRET,
    })

    expect(second.supersededCredentialId).toBe(first.credentialId)

    const rows = await fixtures
      .db()
      .select()
      .from(validationCredentials)
      .where(eq(validationCredentials.validationRunId, validationRunId))

    expect(rows).toHaveLength(2)
    expect(rows.filter((row) => row.revokedAt === null).map((row) => row.id)).toStrictEqual([
      second.credentialId,
    ])
  })

  it('gives every issue a fresh jti, so a replay is recognisable rather than merely unexpired', async () => {
    const validationRunId = await fixtures.seedValidationRun()

    const first = await mintValidationCredential({
      db: fixtures.db(),
      validationRunId,
      secret: SECRET,
    })
    const second = await mintValidationCredential({
      db: fixtures.db(),
      validationRunId,
      secret: SECRET,
    })

    expect(second.jti).not.toBe(first.jti)
  })

  it('refuses to sign with an empty secret, and writes nothing when it does', async () => {
    const validationRunId = await fixtures.seedValidationRun()

    await expect(
      mintValidationCredential({ db: fixtures.db(), validationRunId, secret: '' }),
    ).rejects.toThrow(/empty/)
  })
})

/** The live credential for a validation run, if it has one. Local to this suite. */
const liveValidationCredentialFor = async (
  db: ReturnType<WorkflowFixtures['db']>,
  validationRunId: string,
): Promise<ValidationCredential | undefined> =>
  (
    await db
      .select()
      .from(validationCredentials)
      .where(
        and(
          eq(validationCredentials.validationRunId, validationRunId),
          isNull(validationCredentials.revokedAt),
        ),
      )
      .limit(1)
  ).at(0)
