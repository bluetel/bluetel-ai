import { describe, expect, it, vi } from 'vitest'

import type { SisyphusDatabase } from '../../db'
import type { AuthorisationDenial } from '../context'

import {
  SCOPED_CREDENTIAL_ALGORITHM,
  SCOPED_CREDENTIAL_AUDIENCE,
  SCOPED_CREDENTIAL_ISSUER,
} from './credential-claims'
import type {
  ScopedCredentialJwtResult,
  ScopedCredentialJwtVerifier,
} from './credential-verification'
import { inspectScopedCredential } from './credential-verification'
import {
  createValidationCredentialResolver,
  inspectValidationCredential,
  verifyValidationCredential,
} from './validation-credential'

/**
 * What is covered here, and what deliberately is not (T200, FR-147).
 *
 * **Covered.** Every decision this module makes on its own, against a JOSE binding that is a plain
 * function under the test's control — the same seam and the same discipline as
 * `credential-verification.test.ts`. The load-bearing cases are the two *crossings*: a workflow
 * subject presented here, and a validation subject presented to the workflow verifier. Neither is
 * refused by a check that could be forgotten; each is refused because the resolver has no function
 * that would hand it the other kind of id, and these tests are what would notice if that stopped
 * being true.
 *
 * **Not covered here.** Real cryptography and the Drizzle predicate — the stand-in handle returns
 * whatever rows it was given rather than filtering by `jti`. Both are covered against a live
 * database and a real `jose` in
 * `apps/sisyphus-control-plane/src/credentials/mint-verify-round-trip.test.ts`, which mints with
 * `SignJWT` and verifies with this module.
 */

const SECRET = 'test-signing-secret-not-a-real-one'
const VALIDATION_RUN_ID = '01890a5d-ac96-774b-bcce-b302099a9001'
const CREDENTIAL_ID = '01890a5d-ac96-774b-bcce-b302099a9002'
const WORKFLOW_ID = '01890a5d-ac96-774b-bcce-b302099a8057'
const JTI = 'the-only-validation-jti'

interface StoredValidationCredential {
  readonly id: string
  readonly validationRunId: string
  readonly jti: string
  readonly issuedAt: Date
  readonly expiresAt: Date
  readonly renewalCount: number
  readonly revokedAt: Date | null
}

const storedCredential = (
  overrides: Partial<StoredValidationCredential> = {},
): StoredValidationCredential => ({
  id: CREDENTIAL_ID,
  validationRunId: VALIDATION_RUN_ID,
  jti: JTI,
  issuedAt: new Date('2026-08-06T09:00:00.000Z'),
  // Fifteen minutes against a twelve-hour token ceiling, so "expiry comes from the row" is an
  // assertion with teeth rather than a coincidence.
  expiresAt: new Date('2026-08-06T09:15:00.000Z'),
  renewalCount: 0,
  revokedAt: null,
  ...overrides,
})

/** Returns the rows it was handed. The predicate is Drizzle's job, not this file's. */
const databaseHolding = (rows: readonly StoredValidationCredential[]): SisyphusDatabase =>
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
        // `'sub' in claims`, not `??`: a test that wants to assert an *absent* subject must be able
        // to say so, and a nullish fallback would silently hand it the valid one instead.
        sub: 'sub' in claims ? claims.sub : `validation:${VALIDATION_RUN_ID}`,
        jti: 'jti' in claims ? claims.jti : JTI,
      },
    })

const verifierThatRejects: ScopedCredentialJwtVerifier = () =>
  Promise.reject(new Error('signature verification failed'))

const optionsWith = (
  jwtVerify: ScopedCredentialJwtVerifier,
  db: SisyphusDatabase = databaseThatMustNotBeTouched(),
): Parameters<typeof inspectValidationCredential>[0] => ({ db, secret: SECRET, jwtVerify })

describe('resolving a validation credential', () => {
  it('resolves a valid token to the row behind it, taking expiry from the row', async () => {
    const stored = storedCredential()

    await expect(
      inspectValidationCredential(
        optionsWith(verifierReporting(), databaseHolding([stored])),
        'a-token',
      ),
    ).resolves.toStrictEqual({
      credential: {
        credentialId: CREDENTIAL_ID,
        validationRunId: VALIDATION_RUN_ID,
        jti: JTI,
        expiresAt: stored.expiresAt,
      },
    })
  })

  it('carries no workflow anywhere on the credential it produces', async () => {
    // The property the two disjoint types exist for. A validation credential that carried a
    // `workflowId` — under any name — could satisfy a `machineProcedure` resolver, which would put
    // an id that names no `workflows` row on `ctx.workflowId`.
    const outcome = await inspectValidationCredential(
      optionsWith(verifierReporting(), databaseHolding([storedCredential()])),
      'a-token',
    )

    expect(Object.keys(outcome.credential ?? {}).sort()).toStrictEqual([
      'credentialId',
      'expiresAt',
      'jti',
      'validationRunId',
    ])
  })
})

describe('the refusals', () => {
  it('refuses a token the binding rejects, before touching the database', async () => {
    await expect(
      inspectValidationCredential(optionsWith(verifierThatRejects), 'a-token'),
    ).resolves.toStrictEqual({ credential: null, refusal: 'signature_or_claims_rejected' })
  })

  it('re-checks the pinned algorithm, the issuer and the audience the binding reported', async () => {
    // A host binding that dropped its options, or a library that treated them as advisory, must not
    // be able to widen what the platform accepts — the same property the workflow path holds.
    const cases = [
      [verifierReporting({ alg: 'HS512' }), 'algorithm_not_pinned'],
      [verifierReporting({ iss: 'somebody-else' }), 'issuer_mismatch'],
      [verifierReporting({ aud: 'sisyphus-interactive-surface' }), 'audience_mismatch'],
    ] as const

    for (const [binding, refusal] of cases) {
      await expect(inspectValidationCredential(optionsWith(binding), 'a-token')).resolves.toEqual({
        credential: null,
        refusal,
      })
    }
  })

  it('refuses a subject that names no validation run, including a workflow one', async () => {
    for (const sub of [`workflow:${WORKFLOW_ID}`, 'validation:', WORKFLOW_ID, undefined]) {
      await expect(
        inspectValidationCredential(optionsWith(verifierReporting({ sub })), 'a-token'),
      ).resolves.toStrictEqual({ credential: null, refusal: 'subject_names_no_validation_run' })
    }
  })

  it('is refused in the other direction too, by the workflow verifier', async () => {
    // The crossing that matters most: this is the refusal `credential-verification.ts` has always
    // made, and T200 must not have relaxed it. A validation credential now authorises exactly one
    // procedure, and it must still resolve to no `MachineCredential` at all.
    await expect(
      inspectScopedCredential(
        optionsWith(verifierReporting({ sub: `validation:${VALIDATION_RUN_ID}` })),
        'a-token',
      ),
    ).resolves.toStrictEqual({ credential: null, refusal: 'subject_names_no_workflow' })
  })

  it('refuses a token with no jti, which nothing could then revoke', async () => {
    await expect(
      inspectValidationCredential(optionsWith(verifierReporting({ jti: undefined })), 'a-token'),
    ).resolves.toStrictEqual({ credential: null, refusal: 'jti_absent' })
  })

  it('refuses a jti with no row, and a jti whose row was revoked', async () => {
    await expect(
      inspectValidationCredential(optionsWith(verifierReporting(), databaseHolding([])), 'a-token'),
    ).resolves.toStrictEqual({ credential: null, refusal: 'credential_not_found' })

    await expect(
      inspectValidationCredential(
        optionsWith(
          verifierReporting(),
          databaseHolding([storedCredential({ revokedAt: new Date('2026-08-06T09:05:00.000Z') })]),
        ),
        'a-token',
      ),
    ).resolves.toStrictEqual({ credential: null, refusal: 'credential_revoked' })
  })

  it('refuses a signed subject that disagrees with the row it resolved to', async () => {
    await expect(
      inspectValidationCredential(
        optionsWith(
          verifierReporting(),
          databaseHolding([storedCredential({ validationRunId: 'some-other-run' })]),
        ),
        'a-token',
      ),
    ).resolves.toStrictEqual({
      credential: null,
      refusal: 'credential_validation_run_mismatch',
    })
  })
})

describe('the audit trail', () => {
  it('records the precise refusal, which the coarse one would otherwise lose', async () => {
    const recordDenial = vi.fn<(denial: AuthorisationDenial) => Promise<void>>(() =>
      Promise.resolve(),
    )

    await expect(
      verifyValidationCredential({ ...optionsWith(verifierThatRejects), recordDenial }, 'a-token'),
    ).resolves.toBeNull()

    expect(recordDenial).toHaveBeenCalledWith({
      reason: 'machine_credential_invalid',
      detail: 'signature_or_claims_rejected',
    })
  })

  it('records nothing for a credential that resolved', async () => {
    const recordDenial = vi.fn<(denial: AuthorisationDenial) => Promise<void>>(() =>
      Promise.resolve(),
    )

    await expect(
      verifyValidationCredential(
        {
          ...optionsWith(verifierReporting(), databaseHolding([storedCredential()])),
          recordDenial,
        },
        'a-token',
      ),
    ).resolves.not.toBeNull()

    expect(recordDenial).not.toHaveBeenCalled()
  })

  it('does not let a failing recorder turn a clean refusal into an error', async () => {
    await expect(
      verifyValidationCredential(
        {
          ...optionsWith(verifierThatRejects),
          recordDenial: () => Promise.reject(new Error('the trail is unreachable')),
        },
        'a-token',
      ),
    ).resolves.toBeNull()
  })
})

describe('the resolver the context is handed', () => {
  it('reads the bearer token off the request, and answers null when there is none', async () => {
    const resolve = createValidationCredentialResolver(
      optionsWith(verifierReporting(), databaseHolding([storedCredential()])),
    )

    await expect(resolve(new Headers({ authorization: 'Bearer a-token' }))).resolves.toMatchObject({
      validationRunId: VALIDATION_RUN_ID,
    })
    // No header at all is not a refusal worth recording — the database is never reached.
    await expect(resolve(new Headers())).resolves.toBeNull()
  })
})
