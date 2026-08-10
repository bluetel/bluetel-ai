import {
  createScopedCredentialResolver,
  inspectScopedCredential,
  inspectValidationCredential,
  SCOPED_CREDENTIAL_ALGORITHM,
  SCOPED_CREDENTIAL_AUDIENCE,
  SCOPED_CREDENTIAL_ISSUER,
  SCOPED_CREDENTIAL_MAX_LIFETIME_MS,
  SCOPED_CREDENTIAL_WINDOW_MS,
  verifyScopedCredential,
  verifyValidationCredential,
} from '@bluetel-ai/sisyphus-api/server'
import type { ScopedCredentialJwtVerifier } from '@bluetel-ai/sisyphus-api/server'
import { decodeJwt, jwtVerify, SignJWT } from 'jose'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

// The fixture harness is deliberately absent from `jobs/index.ts` — exporting a seeder from a
// barrel would put it one import away from a job — so a test reaches the module directly.
import { createWorkflowFixtures, readTestDatabaseUrl } from '../jobs/workflow-fixtures'

import { mintScopedCredential, mintValidationCredential } from './mint'
import { revokeScopedCredentials } from './revoke'

/**
 * The two halves of FR-037, made to agree — against a real database and real cryptography.
 *
 * The mint is this application's. The verifier is `@bluetel-ai/sisyphus-api/server`'s, shared with
 * the panel's `/api/machine` mount, which is the point: **there is one verifier**, and the same
 * function that admits a credential in the panel is exercised here against tokens this application
 * actually signed. Nothing in either host restates the claim vocabulary, so there is no second
 * definition for a divergent edit to land in.
 *
 * `packages/sisyphus-api/src/server/machine/credential-verification.test.ts` covers the refusal
 * matrix against a JOSE binding under a test's control. This file covers the two things that can
 * only be shown here: that a token signed by `jose` verifies through the shared module with **no
 * adapter between them**, and that the short window comes from the row.
 */

const connectionString = readTestDatabaseUrl()
const describeWithDatabase = connectionString === undefined ? describe.skip : describe

const SECRET = 'test-signing-secret-not-a-real-one'
const OTHER_SECRET = 'a-different-secret-entirely'

const bearer = (token: string): Headers => new Headers({ authorization: `Bearer ${token}` })

/**
 * `jose`'s `jwtVerify` **is** the host binding: assigned, not wrapped.
 *
 * This assignment is the whole of what a host contributes to verification. If the shared type ever
 * drifted from `jose`'s signature, this line would stop compiling — which is a better warning than
 * an adapter that keeps compiling while quietly checking something else.
 */
const joseBinding: ScopedCredentialJwtVerifier = jwtVerify

describeWithDatabase('a minted credential, verified by the shared verifier', () => {
  const fixtures = createWorkflowFixtures(connectionString ?? '')

  beforeAll(() => fixtures.open(), 60_000)
  afterEach(() => fixtures.removeAll())
  afterAll(() => fixtures.close())

  const options = (): Parameters<typeof verifyScopedCredential>[0] => ({
    db: fixtures.db(),
    secret: SECRET,
    jwtVerify: joseBinding,
  })

  it('resolves a freshly minted token to the row it was minted against', async () => {
    const workflowId = await fixtures.seedWorkflow({ label: 'round-trip' })
    const minted = await mintScopedCredential({ db: fixtures.db(), workflowId, secret: SECRET })

    await expect(verifyScopedCredential(options(), minted.token)).resolves.toStrictEqual({
      credentialId: minted.credentialId,
      workflowId,
      jti: minted.jti,
      expiresAt: minted.expiresAt,
    })
  })

  it('takes expiry from the row, whose window is far shorter than the token it arrived on', async () => {
    const workflowId = await fixtures.seedWorkflow({ label: 'expiry' })
    const issuedAt = new Date()
    const minted = await mintScopedCredential({
      db: fixtures.db(),
      workflowId,
      secret: SECRET,
      now: issuedAt,
    })

    const resolved = await verifyScopedCredential(options(), minted.token)
    const tokenExpiry = decodeJwt(minted.token).exp

    // The row's window is fifteen minutes and the token's ceiling is twelve hours. A verifier that
    // answered with the token's `exp` would make `machine.renewCredential` a no-op — renewal moves
    // the column and puts nothing new on the wire — so every long run would die at the first
    // window boundary having renewed correctly.
    expect(resolved?.expiresAt.getTime()).toBe(issuedAt.getTime() + SCOPED_CREDENTIAL_WINDOW_MS)
    expect((tokenExpiry ?? 0) * 1000).toBe(
      Math.floor((issuedAt.getTime() + SCOPED_CREDENTIAL_MAX_LIFETIME_MS) / 1000) * 1000,
    )
    expect(resolved?.expiresAt.getTime()).toBeLessThan((tokenExpiry ?? 0) * 1000)
  })

  it('refuses a token whose row a teardown revoked, while the token itself is still intact', async () => {
    const workflowId = await fixtures.seedWorkflow({ label: 'revoked' })
    const minted = await mintScopedCredential({ db: fixtures.db(), workflowId, secret: SECRET })

    await revokeScopedCredentials({ db: fixtures.db(), workflowId })

    // The signature still verifies and the ceiling is hours away; the credential is dead because
    // the row says so (FR-038).
    await expect(jwtVerify(minted.token, new TextEncoder().encode(SECRET))).resolves.toBeDefined()
    await expect(inspectScopedCredential(options(), minted.token)).resolves.toStrictEqual({
      credential: null,
      refusal: 'credential_revoked',
    })
  })

  it('refuses the superseded token the moment a re-provision mints its replacement', async () => {
    const workflowId = await fixtures.seedWorkflow({ label: 'superseded' })
    const first = await mintScopedCredential({ db: fixtures.db(), workflowId, secret: SECRET })
    const second = await mintScopedCredential({ db: fixtures.db(), workflowId, secret: SECRET })

    await expect(verifyScopedCredential(options(), first.token)).resolves.toBeNull()
    await expect(verifyScopedCredential(options(), second.token)).resolves.toMatchObject({
      workflowId,
    })
  })

  it('refuses a validation credential, which names no workflow (FR-147, T200)', async () => {
    // The refusal that survives T200, and the reason it must: `validation_credentials` and
    // `machine.reportValidation` now exist, so this token authorises something — one report against
    // one `validation_runs` row. It must still resolve to no `MachineCredential` at all, because
    // every `machineProcedure` reads `ctx.workflowId` and this names a run that does not exist.
    const validationRunId = await fixtures.seedValidationRun()
    const validation = await mintValidationCredential({
      db: fixtures.db(),
      validationRunId,
      secret: SECRET,
    })

    await expect(inspectScopedCredential(options(), validation.token)).resolves.toStrictEqual({
      credential: null,
      refusal: 'subject_names_no_workflow',
    })
  })

  it('resolves that same token through the validation verifier, and only that one (T200)', async () => {
    const validationRunId = await fixtures.seedValidationRun()
    const validation = await mintValidationCredential({
      db: fixtures.db(),
      validationRunId,
      secret: SECRET,
    })

    await expect(inspectValidationCredential(options(), validation.token)).resolves.toStrictEqual({
      credential: {
        credentialId: validation.credentialId,
        validationRunId,
        jti: validation.jti,
        expiresAt: validation.expiresAt,
      },
    })
  })

  it('refuses a workflow credential on the validation verifier, in the other direction', async () => {
    // The mirror of the refusal above, and the reason the two resolvers are separate functions over
    // separate tables rather than one that switches on a subject prefix.
    const workflowId = await fixtures.seedWorkflow({ label: 'not-a-validation' })
    const minted = await mintScopedCredential({ db: fixtures.db(), workflowId, secret: SECRET })

    await expect(inspectValidationCredential(options(), minted.token)).resolves.toStrictEqual({
      credential: null,
      refusal: 'subject_names_no_validation_run',
    })
  })

  it('refuses a validation credential whose row was superseded by a re-mint (T200)', async () => {
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

    // Intact signature, inside its ceiling, and recognisably dead — which is what the row buys.
    await expect(inspectValidationCredential(options(), first.token)).resolves.toStrictEqual({
      credential: null,
      refusal: 'credential_revoked',
    })
    await expect(verifyValidationCredential(options(), second.token)).resolves.toMatchObject({
      validationRunId,
    })
  })

  it('refuses a token signed with another secret, before touching the database', async () => {
    const workflowId = await fixtures.seedWorkflow({ label: 'forged' })
    const minted = await mintScopedCredential({
      db: fixtures.db(),
      workflowId,
      secret: OTHER_SECRET,
    })

    await expect(inspectScopedCredential(options(), minted.token)).resolves.toStrictEqual({
      credential: null,
      refusal: 'signature_or_claims_rejected',
    })
  })

  it('refuses an unsigned token presenting alg none', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ sub: 'workflow:x', jti: 'y' })).toString(
      'base64url',
    )

    await expect(verifyScopedCredential(options(), `${header}.${payload}.`)).resolves.toBeNull()
  })

  it('refuses a token past its own twelve-hour ceiling even though the row is live', async () => {
    const workflowId = await fixtures.seedWorkflow({ label: 'expired-token' })
    const minted = await mintScopedCredential({ db: fixtures.db(), workflowId, secret: SECRET })

    // Re-signed with the same claims but an elapsed ceiling: the row is untouched and live.
    const stale = await new SignJWT({})
      .setProtectedHeader({ alg: SCOPED_CREDENTIAL_ALGORITHM })
      .setIssuer(SCOPED_CREDENTIAL_ISSUER)
      .setAudience(SCOPED_CREDENTIAL_AUDIENCE)
      .setSubject(`workflow:${workflowId}`)
      .setJti(minted.jti)
      .setIssuedAt()
      .setExpirationTime('-1s')
      .sign(new TextEncoder().encode(SECRET))

    await expect(verifyScopedCredential(options(), stale)).resolves.toBeNull()
  })

  it('resolves a bearer credential straight off the request headers', async () => {
    const workflowId = await fixtures.seedWorkflow({ label: 'headers' })
    const minted = await mintScopedCredential({ db: fixtures.db(), workflowId, secret: SECRET })
    const resolve = createScopedCredentialResolver(options())

    await expect(resolve(bearer(minted.token))).resolves.toMatchObject({ workflowId })
    await expect(resolve(new Headers())).resolves.toBeNull()
  })
})
