import type { SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'
import {
  createScopedCredentialResolver,
  inspectScopedCredential,
  SCOPED_CREDENTIAL_ALGORITHM,
  SCOPED_CREDENTIAL_AUDIENCE,
  SCOPED_CREDENTIAL_ISSUER,
} from '@bluetel-ai/sisyphus-api/server'
import { SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'

import { joseCredentialVerifier } from './jose-binding'

/**
 * The panel's mount, end to end, minus the database.
 *
 * The refusal matrix lives with the shared verifier in
 * `packages/sisyphus-api/src/server/machine/credential-verification.test.ts`, where it is asserted
 * against a binding under the test's control. What can only be shown *here* is that this
 * application's actual binding — `jose`, assigned rather than adapted — carries real signed tokens
 * through that verifier and produces the same answers.
 *
 * The stand-in handle returns whatever rows it is given rather than filtering by `jti`; the live
 * database half is `apps/sisyphus-control-plane/src/credentials/mint-verify-round-trip.test.ts`,
 * against the same table and the same verifier.
 */

const SECRET = 'test-signing-secret-not-a-real-one'
const OTHER_SECRET = 'a-different-secret-entirely'
const WORKFLOW_ID = '01890a5d-ac96-774b-bcce-b302099a8057'
const CREDENTIAL_ID = '01890a5d-ac96-774b-bcce-b302099a8058'
const JTI = 'the-only-jti'

const storedCredential = (
  overrides: { readonly revokedAt?: Date; readonly expiresAt?: Date } = {},
): Record<string, unknown> => ({
  id: CREDENTIAL_ID,
  workflowId: WORKFLOW_ID,
  jti: JTI,
  issuedAt: new Date('2026-08-06T09:00:00.000Z'),
  expiresAt: overrides.expiresAt ?? new Date('2026-08-06T09:15:00.000Z'),
  renewalCount: 0,
  revokedAt: overrides.revokedAt ?? null,
})

const databaseHolding = (rows: readonly Record<string, unknown>[]): SisyphusDatabase =>
  ({
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
    }),
  }) as unknown as SisyphusDatabase

const databaseThatMustNotBeTouched = (): SisyphusDatabase =>
  ({
    select: () => {
      throw new Error('The credential was looked up before the token was verified.')
    },
  }) as unknown as SisyphusDatabase

interface TokenOverrides {
  readonly secret?: string
  readonly issuer?: string
  readonly audience?: string
  readonly subject?: string
  readonly expiresIn?: string
}

const signToken = async (overrides: TokenOverrides = {}): Promise<string> =>
  new SignJWT({})
    .setProtectedHeader({ alg: SCOPED_CREDENTIAL_ALGORITHM })
    .setIssuer(overrides.issuer ?? SCOPED_CREDENTIAL_ISSUER)
    .setAudience(overrides.audience ?? SCOPED_CREDENTIAL_AUDIENCE)
    .setSubject(overrides.subject ?? `workflow:${WORKFLOW_ID}`)
    .setJti(JTI)
    .setIssuedAt()
    .setExpirationTime(overrides.expiresIn ?? '12h')
    .sign(new TextEncoder().encode(overrides.secret ?? SECRET))

const optionsFor = (db: SisyphusDatabase): Parameters<typeof inspectScopedCredential>[0] => ({
  db,
  secret: SECRET,
  jwtVerify: joseCredentialVerifier,
})

describe("the panel's JOSE binding, through the shared verifier", () => {
  it('resolves a genuinely signed token to the row, with expiry taken from the row', async () => {
    // The token's ceiling is twelve hours out; the row's window is fifteen minutes. Answering with
    // the token's `exp` would make `machine.renewCredential` a no-op, since renewal moves the
    // column and puts nothing new on the wire.
    const resolved = await inspectScopedCredential(
      optionsFor(databaseHolding([storedCredential()])),
      await signToken(),
    )

    expect(resolved).toStrictEqual({
      credential: {
        credentialId: CREDENTIAL_ID,
        workflowId: WORKFLOW_ID,
        jti: JTI,
        expiresAt: new Date('2026-08-06T09:15:00.000Z'),
      },
    })
  })

  it('refuses a forged signature before the database is consulted', async () => {
    await expect(
      inspectScopedCredential(
        optionsFor(databaseThatMustNotBeTouched()),
        await signToken({ secret: OTHER_SECRET }),
      ),
    ).resolves.toStrictEqual({ credential: null, refusal: 'signature_or_claims_rejected' })
  })

  it('refuses a token addressed to the interactive surface (FR-005)', async () => {
    await expect(
      inspectScopedCredential(
        optionsFor(databaseThatMustNotBeTouched()),
        await signToken({ audience: 'sisyphus-panel' }),
      ),
    ).resolves.toStrictEqual({ credential: null, refusal: 'signature_or_claims_rejected' })
  })

  it('refuses a token from another issuer', async () => {
    await expect(
      inspectScopedCredential(
        optionsFor(databaseThatMustNotBeTouched()),
        await signToken({ issuer: 'somebody-else' }),
      ),
    ).resolves.toStrictEqual({ credential: null, refusal: 'signature_or_claims_rejected' })
  })

  it('refuses an unsigned token presenting alg none', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ sub: 'workflow:x', jti: 'y' })).toString(
      'base64url',
    )

    await expect(
      inspectScopedCredential(optionsFor(databaseThatMustNotBeTouched()), `${header}.${payload}.`),
    ).resolves.toStrictEqual({ credential: null, refusal: 'signature_or_claims_rejected' })
  })

  it('refuses a token past its own ceiling even though the row is live', async () => {
    await expect(
      inspectScopedCredential(
        optionsFor(databaseThatMustNotBeTouched()),
        await signToken({ expiresIn: '-1s' }),
      ),
    ).resolves.toStrictEqual({ credential: null, refusal: 'signature_or_claims_rejected' })
  })

  it('refuses a revoked credential, whose token is otherwise intact (FR-038)', async () => {
    const rows = [storedCredential({ revokedAt: new Date('2026-08-06T09:05:00.000Z') })]

    await expect(
      inspectScopedCredential(optionsFor(databaseHolding(rows)), await signToken()),
    ).resolves.toStrictEqual({ credential: null, refusal: 'credential_revoked' })
  })

  it('is what the mount resolves request headers with', async () => {
    const resolve = createScopedCredentialResolver(
      optionsFor(databaseHolding([storedCredential()])),
    )
    const token = await signToken()

    await expect(resolve(new Headers({ authorization: `Bearer ${token}` }))).resolves.toMatchObject(
      { workflowId: WORKFLOW_ID },
    )
    await expect(resolve(new Headers())).resolves.toBeNull()
  })
})
