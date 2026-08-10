import type { AgentCredential, SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'
import { agentCredentials } from '@bluetel-ai/sisyphus-api/db'
import { and, eq, inArray } from 'drizzle-orm'

import type { SecretReader } from '../../aws'
import { persistRotation } from '../lease'

/**
 * Capturing the material a login produced (T076, FR-008, FR-070, FR-072).
 *
 * ## Where the material is at every moment, and why the panel is never one of them
 *
 * The agent writes its credential into a file on the login instance, exactly as it does on an
 * executor instance mid-run. The control plane reads that file **on the instance**, over the
 * command seam below, and hands the bytes straight to the store. Three places, in order: the
 * instance, one function's arguments inside the control plane, Secrets Manager. The panel is not
 * among them and cannot be — the administrative surface has no port that can carry a value (see
 * `server/admin/credential-login.ts`), so there is no response for material to travel in even if
 * something wanted to put it there.
 *
 * Nothing in this module returns material, logs it, or puts it in an outcome object. {@link
 * CaptureOutcome} says what happened and names identifiers; `capture.test.ts` asserts that the
 * outcome of a successful capture contains no substring of the material that was captured, which is
 * the assertion that would fail if somebody added a `material` field for debugging.
 *
 * ## Why the write goes through `persistRotation`, and why that is the whole point
 *
 * A login and a rotation are the same event seen from two sides: an agent has produced fresh
 * credential material and the platform must file it under the seat's identifier. So this module
 * does not have a write of its own. It calls {@link persistRotation} — the same function the
 * rotation path calls, with the same fence comparison, the same refusal before the store is
 * touched, and the same rule that material goes straight to the store and nowhere else.
 *
 * **One mechanism, one failure mode.** The alternative — a login that wrote to Secrets Manager by
 * its own route — would be a second writer of the same secret, and the fence rule would then be
 * enforced on one of the two paths. The failure that follows is not hypothetical: a re-login
 * completing while a displaced holder is still rotating would race, and whichever wrote last would
 * win, rather than whichever holds the current fence. Sharing the function means a login is
 * fence-checked for free, and means a change to how rotations are stored cannot leave logins behind.
 *
 * **First login is the one case `persistRotation` cannot serve, and it is served beside it rather
 * than inside it.** A seat that has never been logged in has `secret_id` null, and `persistRotation`
 * refuses that deliberately — creating a secret on demand inside a rotation would file material
 * under an identifier nothing references and report success for it. So {@link captureLoginMaterial}
 * creates the secret first, records the identifier the store resolved, and then every subsequent
 * write for that seat — every rotation, and every re-login — goes down the shared path. The
 * asymmetry lasts exactly one call in a credential's life.
 *
 * ## Why the capture is a poll rather than a callback from the instance
 *
 * The login instance has no workflow, so it has no workflow-scoped credential and cannot call the
 * machine surface: `machineProcedure` resolves the caller's seat from `ctx.workflowId`, and
 * `mintValidationCredential` already records that a non-workflow subject "resolves to no credential
 * at all". Giving the machine surface a second authentication mode, or inventing a workflow row for
 * a login, would widen the one surface this feature keeps narrowest (SC-014) in order to save a
 * poll. The control plane already has an authenticated path onto the instance — the same one that
 * relays the terminal — so it reads the file itself and writes through the rotation function.
 */

/**
 * Reading the material file on a login instance.
 *
 * A seam rather than an SSM client for the reason every seam in `aws/` exists: the control plane
 * must be testable without an instance. It is deliberately **one method that answers one path** —
 * not "run a command on an instance", which would be a remote shell available to anything that
 * could reach this interface.
 */
export interface LoginMaterialSource {
  /**
   * The material the agent wrote, or `undefined` when it has not written any yet.
   *
   * "Not yet" is the ordinary answer for most of a login's life and is not an error: the
   * administrator is still typing. A failure to reach the instance at all is an error, and the
   * caller turns it into a reason against the seat.
   */
  readonly read: (input: { readonly environmentId: string }) => Promise<string | undefined>
}

/** The seat as capture needs to see it. */
interface CaptureSeat {
  readonly id: string
  readonly name: string
  readonly state: AgentCredential['state']
  readonly fence: number
  readonly secretId: string | null
}

/**
 * What a capture attempt did. **Identifiers and words, never material** — an outcome object is one
 * `console` call away from being a log line, and SC-014 admits no exceptions.
 */
export type CaptureOutcome =
  /** The agent has not written anything yet. The ordinary answer while somebody is still typing. */
  | { readonly outcome: 'not_ready'; readonly agentCredentialId: string }
  /** Material was stored and the seat is now selectable. */
  | {
      readonly outcome: 'captured'
      readonly agentCredentialId: string
      readonly secretId: string
      /** True when this capture created the seat's secret — its first login. */
      readonly createdSecret: boolean
    }
  /** The seat moved out of a state a login completes from while the attempt was in flight. */
  | { readonly outcome: 'refused'; readonly agentCredentialId: string; readonly reason: string }

export interface CaptureLoginMaterialOptions {
  readonly db: SisyphusDatabase
  readonly materials: LoginMaterialSource
  readonly secrets: SecretReader
  readonly agentCredentialId: string
  readonly environmentId: string
  /** `SISYPHUS_AGENT_CREDENTIAL_SECRET_PREFIX`. Passed in; this module reads no environment. */
  readonly secretNamePrefix: string
  readonly now?: Date
}

/**
 * The states a login may complete from — first login, and re-login on a broken seat.
 *
 * Restated rather than imported from the API package's `LOGIN_ENTRY_STATES`, which is not
 * on that package's server barrel: this is the same construction, and the same reason, as the fence
 * rule being restated in `server/machine/agent-credential.ts`. Typed off the column, so a state
 * this feature does not have is a compile error rather than a condition that silently matches
 * nothing.
 */
const LOGIN_ENTRY_STATES: readonly AgentCredential['state'][] = ['awaiting_login', 'unhealthy']

/** First row, honestly typed — `noUncheckedIndexedAccess` is off in this workspace. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/**
 * The Secrets Manager name one seat's material is filed under (research R8).
 *
 * Derived from the prefix and the credential id rather than from its name, because a name is
 * administrator-chosen and may be changed while the id may not — and a secret whose name stopped
 * matching its seat after a rename would be findable by nobody. Exported so the deployment's IAM
 * policy and this module cannot drift on what the prefix actually produces.
 */
export const loginSecretName = (prefix: string, agentCredentialId: string): string =>
  `${prefix.replace(/\/$/, '')}/${agentCredentialId}`

/**
 * Read the material a login produced and store it, if there is any yet (FR-070, FR-072).
 *
 * Called on a schedule while an environment is live. Returning `not_ready` is the normal answer
 * and costs one command; the caller polls until it is `captured` or the deadline passes.
 *
 * The seat is re-read **inside** this call rather than passed in, because the whole point of the
 * state condition is that the seat may have moved since the login started — an administrator may
 * have disabled it, or a re-login may have been overtaken by an acquisition. A capture into a
 * `held` seat would replace the material a run is currently authenticated with.
 *
 * @param options - The handle, the two seams, the seat, its environment and the secret prefix.
 * @returns What happened. Never material.
 * @throws If the instance could not be reached, or the store rejected the write. Both mean the
 *   platform does not know whether the material is stored, and the caller records the reason
 *   against the seat rather than reporting a login that may not have landed.
 */
export const captureLoginMaterial = async (
  options: CaptureLoginMaterialOptions,
): Promise<CaptureOutcome> => {
  const { agentCredentialId, db, materials, secrets } = options
  const now = options.now ?? new Date()

  const seat = firstRow(
    await db
      .select({
        id: agentCredentials.id,
        name: agentCredentials.name,
        state: agentCredentials.state,
        fence: agentCredentials.fence,
        secretId: agentCredentials.secretId,
      })
      .from(agentCredentials)
      .where(eq(agentCredentials.id, agentCredentialId))
      .limit(1),
  ) as CaptureSeat | undefined

  if (seat === undefined) {
    throw new Error(
      `Agent credential ${agentCredentialId} does not exist, so there is nothing to capture a login into. An environment running for a seat this database has never had is an environment to destroy, not one to wait on.`,
    )
  }

  if (!LOGIN_ENTRY_STATES.includes(seat.state)) {
    return {
      outcome: 'refused',
      agentCredentialId,
      reason: `The credential moved to ${seat.state} while the login was in progress, so the material was not stored. A seat a run is holding must keep the material that run is authenticated with.`,
    }
  }

  const material = await materials.read({ environmentId: options.environmentId })

  if (material === undefined || material === '') {
    return { outcome: 'not_ready', agentCredentialId }
  }

  // First login: the seat has nowhere to be filed. Created here rather than inside
  // `persistRotation`, which refuses a null `secret_id` on purpose — see the module note.
  const existingSecretId = seat.secretId
  const createdSecret = existingSecretId === null
  const secretId =
    existingSecretId ??
    (await secrets.create(loginSecretName(options.secretNamePrefix, seat.id), material))

  if (createdSecret) {
    // Recorded before the seat is made selectable, and in its own statement, so a crash between the
    // two leaves a seat that is unselectable and points at real material — recoverable by another
    // login — rather than a selectable seat pointing at nothing.
    await db
      .update(agentCredentials)
      .set({ secretId, updatedAt: now })
      .where(eq(agentCredentials.id, seat.id))
  } else {
    // Every subsequent write goes down the shared rotation path, fence and all. The fence presented
    // is the credential's own current value: a login is the platform writing on the seat's behalf,
    // not a holder writing under a claim it was issued, so there is no older token to present and
    // nothing for the comparison to reject except a value raised since this read.
    const stored = await persistRotation({
      reader: db,
      secrets,
      agentCredentialId: seat.id,
      presentedFence: seat.fence,
      material,
    })

    if (stored.outcome !== 'accepted') {
      return {
        outcome: 'refused',
        agentCredentialId,
        reason: `The seat was leased while the login was in progress, so the captured material was not stored. Its fence moved from ${String(stored.presentedFence)} to ${String(stored.currentFence)}.`,
      }
    }
  }

  // The seat becomes selectable only now, and only from a state a login completes from. The
  // condition is what makes an acquisition landing between the read above and this write lose the
  // race rather than slip through it.
  const completed = await db
    .update(agentCredentials)
    .set({ state: 'available', lastLoginAt: now, lastFailureReason: null, updatedAt: now })
    .where(
      and(eq(agentCredentials.id, seat.id), inArray(agentCredentials.state, LOGIN_ENTRY_STATES)),
    )
    .returning({ id: agentCredentials.id })

  if (completed.length === 0) {
    return {
      outcome: 'refused',
      agentCredentialId,
      reason:
        'The credential stopped awaiting a login while the material was being stored, so it was not made selectable. The material is filed against the seat; start the login again if it is still needed.',
    }
  }

  return { outcome: 'captured', agentCredentialId, secretId, createdSecret }
}
