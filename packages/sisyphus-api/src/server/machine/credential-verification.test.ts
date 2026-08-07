import { describe, expect, it } from 'vitest'

import type { SisyphusDatabase } from '../../db'
import type { AuthorisationDenial } from '../context'

import {
  SCOPED_CREDENTIAL_ALGORITHM,
  SCOPED_CREDENTIAL_AUDIENCE,
  SCOPED_CREDENTIAL_ISSUER,
} from './credential-claims'
import type {
  ScopedCredentialJwtOptions,
  ScopedCredentialJwtResult,
  ScopedCredentialJwtVerifier,
} from './credential-verification'
import {
  bearerTokenFrom,
  createScopedCredentialResolver,
  inspectScopedCredential,
  verifyScopedCredential,
} from './credential-verification'

/**
 * What is covered here, and what deliberately is not.
 *
 * **Covered.** Every decision this module makes on its own, against a JOSE binding that is a plain
 * function under the test's control. That is the point of the seam: the refusals below are the
 * platform's policy, and they hold whatever a host's library does or does not check. The two most
 * load-bearing cases are the ones a *permissive* binding produces — a verifier that accepts a
 * foreign issuer or a foreign audience — because those are exactly what a mis-wired host would
 * hand over, and they are refused here regardless.
 *
 * **Not covered here.** Real cryptography, and the Drizzle predicate. The stand-in handle returns
 * whatever rows it was given rather than filtering by `jti`, so this file proves what the module
 * decides, not that the query composes. Both are covered against the live database and a real
 * `jose` in `apps/sisyphus-control-plane/src/credentials/mint-verify-round-trip.test.ts`, which
 * mints with `SignJWT` and verifies with this module.
 */

const SECRET = 'test-signing-secret-not-a-real-one'
const WORKFLOW_ID = '01890a5d-ac96-774b-bcce-b302099a8057'
const CREDENTIAL_ID = '01890a5d-ac96-774b-bcce-b302099a8058'
const JTI = 'the-only-jti'

interface StoredCredential {
  readonly id: string
  readonly workflowId: string
  readonly jti: string
  readonly issuedAt: Date
  readonly expiresAt: Date
  readonly renewalCount: number
  readonly revokedAt: Date | null
}

const storedCredential = (overrides: Partial<StoredCredential> = {}): StoredCredential => ({
  id: CREDENTIAL_ID,
  workflowId: WORKFLOW_ID,
  jti: JTI,
  issuedAt: new Date('2026-08-06T09:00:00.000Z'),
  // Fifteen minutes. The token's own ceiling is twelve hours, and the gap between them is what
  // makes "expiry comes from the row" an assertion with teeth rather than a coincidence.
  expiresAt: new Date('2026-08-06T09:15:00.000Z'),
  renewalCount: 0,
  revokedAt: null,
  ...overrides,
})

/** Returns the rows it was handed. The predicate is Drizzle's job, not this file's. */
const databaseHolding = (rows: readonly StoredCredential[]): SisyphusDatabase =>
  ({
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
    }),
  }) as unknown as SisyphusDatabase

/** Fails the test if the module reaches the database at all. */
const databaseThatMustNotBeTouched = (): SisyphusDatabase =>
  ({
    select: () => {
      throw new Error('The credential was looked up before the token was verified.')
    },
  }) as unknown as SisyphusDatabase

/** A correct binding: it reports the claims it was asked to check. */
const verifierReporting =
  (
    claims: Partial<ScopedCredentialJwtResult['payload']> & { readonly alg?: string } = {},
  ): ScopedCredentialJwtVerifier =>
  (): Promise<ScopedCredentialJwtResult> =>
    Promise.resolve({
      protectedHeader: { alg: claims.alg ?? SCOPED_CREDENTIAL_ALGORITHM },
      payload: {
        iss: claims.iss ?? SCOPED_CREDENTIAL_ISSUER,
        aud: claims.aud ?? SCOPED_CREDENTIAL_AUDIENCE,
        sub: claims.sub ?? `workflow:${WORKFLOW_ID}`,
        jti: 'jti' in claims ? claims.jti : JTI,
      },
    })

/** A binding that rejects, as `jose` does for a bad signature or an expired ceiling. */
const verifierThatRejects: ScopedCredentialJwtVerifier = () =>
  Promise.reject(new Error('signature verification failed'))

const optionsWith = (
  jwtVerify: ScopedCredentialJwtVerifier,
  db: SisyphusDatabase = databaseThatMustNotBeTouched(),
): Parameters<typeof inspectScopedCredential>[0] => ({ db, secret: SECRET, jwtVerify })

describe('reading the credential off a request', () => {
  it('takes the token from an Authorization bearer header, scheme-insensitively', () => {
    expect(bearerTokenFrom(new Headers({ authorization: 'Bearer abc' }))).toBe('abc')
    expect(bearerTokenFrom(new Headers({ authorization: 'bearer abc' }))).toBe('abc')
    expect(bearerTokenFrom(new Headers({ authorization: 'BEARER  abc ' }))).toBe('abc')
  })

  it('reads nothing from an absent header, one with no scheme, or a foreign scheme', () => {
    expect(bearerTokenFrom(new Headers())).toBeUndefined()
    expect(bearerTokenFrom(new Headers({ authorization: 'abc' }))).toBeUndefined()
    expect(bearerTokenFrom(new Headers({ authorization: 'Basic abc' }))).toBeUndefined()
    expect(bearerTokenFrom(new Headers({ authorization: 'Bearer ' }))).toBeUndefined()
  })
})

describe('what the host binding is told to check', () => {
  it('hands it the pinned algorithm, issuer and audience, and the secret as a key', async () => {
    let seen: { key: Uint8Array; options: ScopedCredentialJwtOptions } | undefined

    const recording: ScopedCredentialJwtVerifier = async (_token, key, options) => {
      seen = { key, options }
      return verifierReporting()('t', key, options)
    }

    await inspectScopedCredential(
      optionsWith(recording, databaseHolding([storedCredential()])),
      't',
    )

    expect(seen?.options).toStrictEqual({
      algorithms: [SCOPED_CREDENTIAL_ALGORITHM],
      issuer: SCOPED_CREDENTIAL_ISSUER,
      audience: SCOPED_CREDENTIAL_AUDIENCE,
    })
    expect(seen?.key).toStrictEqual(new TextEncoder().encode(SECRET))
  })

  it('refuses an empty secret rather than verifying with a forgeable key', async () => {
    const outcome = await inspectScopedCredential(
      { db: databaseThatMustNotBeTouched(), secret: '', jwtVerify: verifierReporting() },
      'any-token',
    )

    // `credentialSigningKey` throws inside the same guarded region as a signature failure, so an
    // empty-secret deployment refuses every request rather than accepting every forgery.
    expect(outcome).toStrictEqual({ credential: null, refusal: 'signature_or_claims_rejected' })
  })
})

describe('refusals decided before the database is consulted', () => {
  it('refuses whatever the binding itself rejected — a bad signature, or a token past its ceiling', async () => {
    await expect(
      inspectScopedCredential(optionsWith(verifierThatRejects), 'forged'),
    ).resolves.toStrictEqual({ credential: null, refusal: 'signature_or_claims_rejected' })
  })

  /**
   * The three below are the reason the claim policy is re-checked rather than delegated. Each
   * simulates a host binding that verified the signature and then let a claim through — the shape
   * of a mis-wired mount, or of a library that treated an option as advisory. None of them can
   * widen what the platform accepts.
   */
  it('refuses a token whose header names an algorithm other than the pinned one', async () => {
    await expect(
      inspectScopedCredential(optionsWith(verifierReporting({ alg: 'none' })), 't'),
    ).resolves.toStrictEqual({ credential: null, refusal: 'algorithm_not_pinned' })
  })

  it('refuses a token from another issuer even if the binding accepted it', async () => {
    await expect(
      inspectScopedCredential(optionsWith(verifierReporting({ iss: 'somebody-else' })), 't'),
    ).resolves.toStrictEqual({ credential: null, refusal: 'issuer_mismatch' })
  })

  it('refuses a token addressed to the interactive surface even if the binding accepted it (FR-005)', async () => {
    await expect(
      inspectScopedCredential(optionsWith(verifierReporting({ aud: 'sisyphus-panel' })), 't'),
    ).resolves.toStrictEqual({ credential: null, refusal: 'audience_mismatch' })
  })

  it('accepts an audience array that includes the machine surface, as RFC 7519 allows', async () => {
    const options = optionsWith(
      verifierReporting({ aud: ['something-else', SCOPED_CREDENTIAL_AUDIENCE] }),
      databaseHolding([storedCredential()]),
    )

    await expect(inspectScopedCredential(options, 't')).resolves.toMatchObject({
      credential: { workflowId: WORKFLOW_ID },
    })
  })

  it('refuses a validation subject, which names no workflow', async () => {
    await expect(
      inspectScopedCredential(optionsWith(verifierReporting({ sub: 'validation:some-run' })), 't'),
    ).resolves.toStrictEqual({ credential: null, refusal: 'subject_names_no_workflow' })
  })

  it('refuses a bare subject that is not prefixed as a workflow', async () => {
    await expect(
      inspectScopedCredential(optionsWith(verifierReporting({ sub: WORKFLOW_ID })), 't'),
    ).resolves.toStrictEqual({ credential: null, refusal: 'subject_names_no_workflow' })
  })

  it('refuses a token carrying no jti, which names no row to look up', async () => {
    await expect(
      inspectScopedCredential(optionsWith(verifierReporting({ jti: undefined })), 't'),
    ).resolves.toStrictEqual({ credential: null, refusal: 'jti_absent' })
  })
})

describe('refusals decided by the stored row', () => {
  it('refuses a jti with no row — a superseded or torn-down credential', async () => {
    await expect(
      inspectScopedCredential(optionsWith(verifierReporting(), databaseHolding([])), 't'),
    ).resolves.toStrictEqual({ credential: null, refusal: 'credential_not_found' })
  })

  it('refuses a revoked credential, which is what teardown performs (FR-038)', async () => {
    const rows = [storedCredential({ revokedAt: new Date('2026-08-06T09:05:00.000Z') })]

    await expect(
      inspectScopedCredential(optionsWith(verifierReporting(), databaseHolding(rows)), 't'),
    ).resolves.toStrictEqual({ credential: null, refusal: 'credential_revoked' })
  })

  it('refuses when the signed subject and the row disagree about whose credential this is', async () => {
    const rows = [storedCredential({ workflowId: '01890a5d-ac96-774b-bcce-b302099a8099' })]

    await expect(
      inspectScopedCredential(optionsWith(verifierReporting(), databaseHolding(rows)), 't'),
    ).resolves.toStrictEqual({ credential: null, refusal: 'credential_workflow_mismatch' })
  })
})

describe('a credential that verifies', () => {
  it('resolves to the row, taking expiry from the row and not from the token', async () => {
    // The token's ceiling is twelve hours out and this module never looks at it; the row's window
    // is fifteen minutes. Returning the token's `exp` would make `machine.renewCredential` a no-op,
    // since renewal moves the column and puts nothing new on the wire.
    const options = optionsWith(verifierReporting(), databaseHolding([storedCredential()]))

    await expect(verifyScopedCredential(options, 't')).resolves.toStrictEqual({
      credentialId: CREDENTIAL_ID,
      workflowId: WORKFLOW_ID,
      jti: JTI,
      expiresAt: new Date('2026-08-06T09:15:00.000Z'),
    })
  })

  it('follows the row when a renewal has moved it, rather than any value fixed at mint', async () => {
    const renewed = storedCredential({ expiresAt: new Date('2026-08-06T11:45:00.000Z') })
    const options = optionsWith(verifierReporting(), databaseHolding([renewed]))

    await expect(verifyScopedCredential(options, 't')).resolves.toMatchObject({
      expiresAt: new Date('2026-08-06T11:45:00.000Z'),
    })
  })
})

describe('the audit trail a refusal leaves', () => {
  const recorderOf = (): {
    readonly recordDenial: (denial: AuthorisationDenial) => Promise<void>
    readonly denials: AuthorisationDenial[]
  } => {
    const denials: AuthorisationDenial[] = []
    return {
      denials,
      recordDenial: (denial) => {
        denials.push(denial)
        return Promise.resolve()
      },
    }
  }

  it('records the precise reason, which `machine_credential_missing` cannot express', async () => {
    const recorder = recorderOf()

    await verifyScopedCredential(
      { ...optionsWith(verifierReporting({ aud: 'sisyphus-panel' })), ...recorder },
      't',
    )

    expect(recorder.denials).toStrictEqual([
      { reason: 'machine_credential_invalid', detail: 'audience_mismatch' },
    ])
  })

  it('says nothing about a request that simply carried no credential', async () => {
    const recorder = recorderOf()
    const resolve = createScopedCredentialResolver({
      ...optionsWith(verifierReporting()),
      ...recorder,
    })

    await expect(resolve(new Headers())).resolves.toBeNull()
    expect(recorder.denials).toStrictEqual([])
  })

  it('records nothing about a credential that verified', async () => {
    const recorder = recorderOf()

    await verifyScopedCredential(
      {
        ...optionsWith(verifierReporting(), databaseHolding([storedCredential()])),
        ...recorder,
      },
      't',
    )

    expect(recorder.denials).toStrictEqual([])
  })

  it('still refuses when the recorder itself fails', async () => {
    // Losing the trail must not turn a clean refusal into an internal error, which the caller
    // would retry.
    await expect(
      verifyScopedCredential(
        {
          ...optionsWith(verifierThatRejects),
          recordDenial: () => Promise.reject(new Error('the denial writer is down')),
        },
        't',
      ),
    ).resolves.toBeNull()
  })
})

describe('createScopedCredentialResolver', () => {
  it('answers null for a request carrying no credential, without a lookup', async () => {
    const resolve = createScopedCredentialResolver(optionsWith(verifierReporting()))

    await expect(resolve(new Headers())).resolves.toBeNull()
  })

  it('resolves a bearer credential off the request headers', async () => {
    const resolve = createScopedCredentialResolver(
      optionsWith(verifierReporting(), databaseHolding([storedCredential()])),
    )

    await expect(
      resolve(new Headers({ authorization: 'Bearer a.compact.token' })),
    ).resolves.toMatchObject({ workflowId: WORKFLOW_ID })
  })
})
