import type { CredentialRotationRejection } from '@bluetel-ai/sisyphus-api/contracts'
import type { SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'
import { agentCredentials } from '@bluetel-ai/sisyphus-api/db'
import { eq } from 'drizzle-orm'

import type { SecretReader } from '../../aws'

/**
 * The fence — what stops a displaced holder overwriting newer material with its stale copy
 * (FR-020, FR-031, research R9).
 *
 * The failure this exists for does not look like a failure from inside the process that causes it.
 * A holder whose lease was force-released is not told. If it is partitioned rather than dead it
 * keeps working, keeps rotating its login, and keeps writing its copy of the material over whatever
 * is stored — replacing the new holder's credential with one the provider has already invalidated.
 * The symptom arrives much later, as an authentication failure with nothing pointing at the cause.
 *
 * Lease expiry cannot address it, and is worse than useless here: a parked workflow legitimately
 * holds a seat for days without heartbeating, so expiry would reclaim live claims to solve a
 * problem it cannot detect anyway. The fence works because it is a fact about the **credential**
 * rather than about who is alive. Acquisition raises `agent_credentials.fence` and issues the new
 * value to the lease; every write presents the value it was given; anything below the credential's
 * current value is refused. Nobody has to decide whether the writer is still running.
 *
 * The token lives on the credential rather than on the lease for the same reason — it has to
 * outlive the lease that raised it. On the lease it would vanish with the row a force-release stops
 * being live, and the displaced holder's next write would land on material the new holder owns.
 *
 * ## Two things this deliberately does not consult
 *
 * **Whether the lease is still live**, and **whether the workflow is still running.** FR-032 says a
 * rotation persisted after its workflow has terminated must still be stored if it is newer, and
 * that requirement is satisfied here by *omission* rather than by a special case: an agent that
 * rotated its login on its last turn produced the newest material there is, and discarding it
 * because the run had finished would leave the next holder authenticating with a copy the provider
 * has invalidated. The fence is the only ordering there is; offering a second one to compare
 * against would invite some later caller to trust the wrong one.
 *
 * Because releases are rare under FR-019, the fence rarely advances at all. It exists for the
 * force-release and reconciliation paths — precisely the cases where a previous holder may still be
 * running.
 *
 * ## Where the material goes
 *
 * Straight to the secret store and nowhere else (FR-011, R8). Nothing in this module puts material
 * in Postgres, returns it to a caller, or includes it in an outcome that could be logged — the
 * refusal is decided *before* the store is touched, because `SecretReader.write` versions the value
 * in Secrets Manager and a refusal that wrote first would leave the superseded material recoverable
 * as the newest version.
 */

/**
 * The one word a refusal is reported with, so callers never match on prose.
 *
 * `satisfies CredentialRotationRejection` rather than a bare literal: the machine surface already
 * owns this vocabulary in `contracts/agent-credential.ts`, where it is a closed enum on the wire.
 * Two spellings of the same rejection is how the executor ends up unable to tell "you have lost the
 * seat" from "nothing to do", so the compiler is made to check that this is the same word.
 *
 * The contract's **other** rejection, `not_newer`, is deliberately not implemented here. It means
 * the fence is current but the payload carries nothing new, which is a comparison of *material* —
 * so it belongs to whoever holds the material at the moment of the write (the machine surface,
 * T052) and not to the module whose entire job is the fence.
 */
export const STALE_FENCE = 'stale_fence' as const satisfies CredentialRotationRejection

export interface FenceComparison {
  /** The value the writer was issued at acquisition and has carried since. */
  readonly presentedFence: number
  /** The value on the credential row now. */
  readonly currentFence: number
}

/**
 * Whether a write presenting this fence may proceed.
 *
 * The rule is "nothing **below** the current value", not "exactly the current value". A fence above
 * the current one is unreachable — only acquisition raises the token, and it raises the
 * credential's copy first — but accepting it is still the right answer: such a writer is not the
 * stale holder this guards against, and refusing it would turn an impossible state into a lost
 * rotation.
 */
export const isFenceCurrent = ({ currentFence, presentedFence }: FenceComparison): boolean =>
  presentedFence >= currentFence

/** What the fence check needs from a handle — a pooled client or an open transaction. */
export type FenceReader = Pick<SisyphusDatabase, 'select'>

export interface PersistRotationOptions {
  readonly reader: FenceReader
  /** Where material lives. The only thing in this module that ever sees it. */
  readonly secrets: SecretReader
  readonly agentCredentialId: string
  /** The fence the writer's lease carries. */
  readonly presentedFence: number
  /** The rotated credential material. Never logged, never returned, never stored in Postgres. */
  readonly material: string
}

/**
 * What happened to a rotation write. Carries no material, by construction — an outcome object is
 * one `console` call away from being a log line, and SC-014 admits no exceptions.
 */
export interface RotationOutcome {
  readonly outcome: 'accepted' | typeof STALE_FENCE
  readonly agentCredentialId: string
  readonly presentedFence: number
  readonly currentFence: number
}

/** The first row, honestly typed. See the same helper in `allocate/select.ts`. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/**
 * Store rotated material for a credential, if the writer's fence is current.
 *
 * The comparison is made without taking a lock, deliberately. Research R9 rejected advisory locks
 * for this job because they vanish on connection loss, which is the same partition problem one
 * layer down — and a lock held across a call to Secrets Manager would be a lock held across a
 * network round trip to another service. The fence is the ordering; it does not need protecting by
 * a second one.
 *
 * @param options - The credential, the fence the writer holds, and the material.
 * @returns Accepted, or refused as {@link STALE_FENCE} with both fences so the caller can report
 *   what happened without re-reading anything.
 * @throws If the credential does not exist, or has no secret to write to. Both mean the caller and
 *   the database disagree about what exists, and creating a secret on demand would file material
 *   under an identifier nothing references while reporting success for it.
 */
export const persistRotation = async (
  options: PersistRotationOptions,
): Promise<RotationOutcome> => {
  const { agentCredentialId, material, presentedFence, reader, secrets } = options

  const credential = firstRow(
    await reader
      .select({ fence: agentCredentials.fence, secretId: agentCredentials.secretId })
      .from(agentCredentials)
      .where(eq(agentCredentials.id, agentCredentialId))
      .limit(1),
  )

  if (credential === undefined) {
    throw new Error(
      `Agent credential ${agentCredentialId} does not exist, so there is nothing to rotate. A writer presenting a lease for a credential this database has never had is looking at a different database.`,
    )
  }

  const currentFence = credential.fence

  if (!isFenceCurrent({ presentedFence, currentFence })) {
    // Refused before the store is touched. See the module note on why the order matters.
    return { outcome: STALE_FENCE, agentCredentialId, presentedFence, currentFence }
  }

  if (credential.secretId === null) {
    throw new Error(
      `Agent credential ${agentCredentialId} has no secret to rotate into. Material lives in Secrets Manager under an identifier recorded at login (FR-008, FR-011); creating one here would file a login against a credential nothing has proved, and report success for it.`,
    )
  }

  await secrets.write(credential.secretId, material)

  return { outcome: 'accepted', agentCredentialId, presentedFence, currentFence }
}
