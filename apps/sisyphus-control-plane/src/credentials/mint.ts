import { randomUUID } from 'node:crypto'

import type { ScopedCredential, SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'
import { scopedCredentials } from '@bluetel-ai/sisyphus-api/db'
import {
  credentialSigningKey,
  SCOPED_CREDENTIAL_ALGORITHM,
  SCOPED_CREDENTIAL_AUDIENCE,
  SCOPED_CREDENTIAL_ISSUER,
  SCOPED_CREDENTIAL_MAX_LIFETIME_MS,
  SCOPED_CREDENTIAL_WINDOW_MS,
  validationSubject,
  workflowSubject,
} from '@bluetel-ai/sisyphus-api/server'
import { and, eq, isNull } from 'drizzle-orm'
import { SignJWT } from 'jose'

/**
 * Minting the one credential a run is issued (T053, FR-037).
 *
 * **Minting is the control plane's alone.** `machine.renewCredential` extends the
 * `scoped_credentials` row a caller is already authenticated against; it cannot create one, widen
 * one or revive a revoked one. So this module is the only place in the platform where new
 * credential material comes into existence, which is what makes "short-lived, one workflow,
 * machine surface only" a property of one function rather than a convention several call sites
 * have to keep.
 *
 * ## What is signed, and what is authoritative
 *
 * The token is signed with the deployed secret and carries the claims described in
 * `packages/sisyphus-api/src/server/machine/credential-claims.ts`. The vocabulary lives there
 * rather than beside this mint because the verifying half is mounted by a different application
 * that cannot import this one, and the two halves agreeing is the whole of FR-037.
 * The **row** is what says whether the credential is still good: `machineProcedure` reads
 * `expiresAt` off the resolved credential, `renewCredential` moves it, and revocation is a column.
 * The token cannot be revoked and the row cannot be forged, so the two together give both
 * properties and neither alone does.
 *
 * ## Why a mint supersedes rather than fails
 *
 * `scoped_credentials_live_key` is a partial unique index on `(workflow_id) WHERE revoked_at IS
 * NULL` — one live credential per run. A second mint for the same workflow is not a mistake: it is
 * a re-provision, which is how a resumed run (FR-151) and a retried hand-off after a launch
 * failure both arrive here. So minting **revokes the incumbent inside the same transaction** and
 * inserts a fresh row. The alternative — losing on the index — would make a resume fail on a
 * constraint whose message is about an index, for a situation that is entirely ordinary.
 *
 * Superseding is also what makes the old token stop working the moment the new one exists: the
 * verifier looks a token's `jti` up and refuses a revoked row, so the credential that went out on
 * the previous instance's user-data is dead before the replacement instance boots.
 *
 * ## Why `jti` is fresh every time
 *
 * `randomUUID` per issue, against `scoped_credentials_jti_key`. A replayed token is therefore
 * *recognisable* rather than merely unexpired: its `jti` resolves to a row that is revoked (or to
 * no row at all), so the verifier can say "this credential was superseded" instead of "this token
 * has not run out yet". A `jti` derived from the workflow id would make every credential a run
 * ever held indistinguishable from the current one.
 */

/** What a mint hands back: the token for the envelope, and the row it is backed by. */
export interface MintedScopedCredential {
  /** The signed compact JWT. This is the only copy — nothing stores it. */
  readonly token: string
  readonly credentialId: string
  readonly jti: string
  readonly workflowId: string
  readonly issuedAt: Date
  /** The short window `machineProcedure` enforces, not the token's ceiling. */
  readonly expiresAt: Date
  /** Set when this mint revoked an incumbent credential for the same run. */
  readonly supersededCredentialId: string | undefined
}

export interface MintScopedCredentialOptions {
  readonly db: SisyphusDatabase
  readonly workflowId: string
  /** `SISYPHUS_MACHINE_CREDENTIAL_SECRET`. Passed in; this module reads no environment. */
  readonly secret: string
  /** Injectable clock, so expiry arithmetic is testable without waiting. */
  readonly now?: Date
}

/** See `jobs/admit-workflow.ts`: `noUncheckedIndexedAccess` is off, so indexing needs a type. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/**
 * Sign one compact JWT.
 *
 * Split out so {@link mintScopedCredential} and {@link mintValidationCredential} cannot drift on
 * issuer, audience, algorithm or ceiling — the four claims that decide what a token is allowed to
 * be presented to.
 */
const signCredential = async (input: {
  readonly subject: string
  readonly jti: string
  readonly secret: string
  readonly issuedAt: Date
  readonly credentialId?: string
}): Promise<string> => {
  const issuedAtSeconds = Math.floor(input.issuedAt.getTime() / 1000)
  const expirySeconds = Math.floor(
    (input.issuedAt.getTime() + SCOPED_CREDENTIAL_MAX_LIFETIME_MS) / 1000,
  )

  const builder = new SignJWT(input.credentialId === undefined ? {} : { cid: input.credentialId })
    .setProtectedHeader({ alg: SCOPED_CREDENTIAL_ALGORITHM })
    .setIssuer(SCOPED_CREDENTIAL_ISSUER)
    .setAudience(SCOPED_CREDENTIAL_AUDIENCE)
    .setSubject(input.subject)
    .setJti(input.jti)
    .setIssuedAt(issuedAtSeconds)
    .setNotBefore(issuedAtSeconds)
    .setExpirationTime(expirySeconds)

  return builder.sign(credentialSigningKey(input.secret))
}

/**
 * Mint the credential one workflow's executor will report with.
 *
 * @param options - The handle, the run, the signing secret and optionally the clock.
 * @returns The token and the row behind it. The token is not stored anywhere: this return value is
 *   the only copy, and it goes straight into the user-data envelope.
 * @throws If the insert produces no row, which would leave a signed token with nothing backing it
 *   — a credential the verifier would reject, handed to an instance that had already booted.
 */
export const mintScopedCredential = async (
  options: MintScopedCredentialOptions,
): Promise<MintedScopedCredential> => {
  const { db, secret, workflowId } = options
  const issuedAt = options.now ?? new Date()
  const expiresAt = new Date(issuedAt.getTime() + SCOPED_CREDENTIAL_WINDOW_MS)
  const jti = randomUUID()

  // Signed before the transaction opens. Signing cannot fail for a reason the database could fix,
  // and an empty-secret deployment should not have written a row before it finds that out.
  const credential = await db.transaction(async (tx) => {
    const superseded = firstRow(
      await tx
        .update(scopedCredentials)
        .set({ revokedAt: issuedAt })
        .where(
          and(eq(scopedCredentials.workflowId, workflowId), isNull(scopedCredentials.revokedAt)),
        )
        .returning({ id: scopedCredentials.id }),
    )

    const inserted = firstRow(
      await tx
        .insert(scopedCredentials)
        .values({ workflowId, jti, expiresAt, issuedAt })
        .returning(),
    )

    if (inserted === undefined) {
      throw new Error(
        `No scoped credential row was written for workflow ${workflowId}. Handing an instance a token with nothing backing it would produce a run that boots and is then refused by every report it makes.`,
      )
    }

    return { inserted, supersededCredentialId: superseded?.id }
  })

  const token = await signCredential({
    subject: workflowSubject(workflowId),
    jti,
    secret,
    issuedAt,
    credentialId: credential.inserted.id,
  })

  return {
    token,
    credentialId: credential.inserted.id,
    jti,
    workflowId,
    issuedAt,
    expiresAt: credential.inserted.expiresAt,
    supersededCredentialId: credential.supersededCredentialId,
  }
}

/**
 * Mint the token a **bundle validation run** carries (T047, FR-147).
 *
 * There is no database row, because there cannot be one: `scoped_credentials.workflow_id` is `not
 * null` and a validation run deliberately has no workflow (FR-147 keeps `workflows.owner_user_id`,
 * `assembled_prompt` and `workspace_version_id` non-null for real runs rather than loosening them
 * to accommodate a validation).
 *
 * So this token is bounded by its `exp` alone, and
 * {@link import('./verify').createScopedCredentialResolver} **refuses it** — a subject that is not
 * `workflow:<id>` resolves to no credential at all. That is deliberate. The envelope
 * `executor-protocol.md` specifies carries a `scopedCredential` in validation mode, so one is
 * minted and the envelope is the shape the contract says; but until the machine surface grows a
 * validation-run reporting procedure there is nothing for it to authorise, and a token that
 * authorised *something* in the meantime would be the wrong kind of guess.
 */
export const mintValidationCredential = async (options: {
  readonly validationRunId: string
  readonly secret: string
  readonly now?: Date
}): Promise<{ readonly token: string; readonly jti: string; readonly issuedAt: Date }> => {
  const issuedAt = options.now ?? new Date()
  const jti = randomUUID()

  return {
    token: await signCredential({
      subject: validationSubject(options.validationRunId),
      jti,
      secret: options.secret,
      issuedAt,
    }),
    jti,
    issuedAt,
  }
}

/** The live credential for a run, if it has one. */
export const liveCredentialFor = async (
  db: SisyphusDatabase,
  workflowId: string,
): Promise<ScopedCredential | undefined> =>
  firstRow(
    await db
      .select()
      .from(scopedCredentials)
      .where(and(eq(scopedCredentials.workflowId, workflowId), isNull(scopedCredentials.revokedAt)))
      .limit(1),
  )
