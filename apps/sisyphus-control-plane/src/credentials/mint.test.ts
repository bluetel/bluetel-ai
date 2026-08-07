import { scopedCredentials } from '@bluetel-ai/sisyphus-api/db'
import {
  credentialSigningKey,
  SCOPED_CREDENTIAL_AUDIENCE,
  SCOPED_CREDENTIAL_ISSUER,
  SCOPED_CREDENTIAL_MAX_LIFETIME_MS,
  SCOPED_CREDENTIAL_WINDOW_MS,
} from '@bluetel-ai/sisyphus-api/server'
import { eq } from 'drizzle-orm'
import { decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

// The fixture harness is deliberately absent from `jobs/index.ts` — exporting a seeder from a
// barrel would put it one import away from a job — so a test reaches the module directly. That is
// the only sanctioned way in, and it is why this import looks like a barrel violation and is not.
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

describe('minting a validation-run token', () => {
  it('signs a subject in the validation space and writes no row', async () => {
    // No database: a validation run has no workflow, so there is no `scoped_credentials` row it
    // could be backed by — `workflow_id` on that table is `not null`.
    const minted = await mintValidationCredential({
      validationRunId: '22222222-2222-2222-2222-222222222222',
      secret: SECRET,
    })

    const { payload } = await jwtVerify(minted.token, credentialSigningKey(SECRET), {
      issuer: SCOPED_CREDENTIAL_ISSUER,
      audience: SCOPED_CREDENTIAL_AUDIENCE,
    })

    expect(payload.sub).toBe('validation:22222222-2222-2222-2222-222222222222')
    expect(payload.cid).toBeUndefined()
  })
})
