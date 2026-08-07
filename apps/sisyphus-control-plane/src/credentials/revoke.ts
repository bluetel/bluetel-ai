import type { SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'
import { scopedCredentials } from '@bluetel-ai/sisyphus-api/db'
import { and, eq, isNull } from 'drizzle-orm'

/**
 * Revocation — the second half of FR-038's "destroy the instance **and revoke its credential**".
 *
 * ## Why this is an action rather than an expiry
 *
 * A credential that merely expires stays usable for the remainder of its window, and the window is
 * the fifteen minutes `machine.renewCredential` keeps reopening. Waiting one out would mean that
 * for a quarter of an hour after a run finished, a process still on the instance — or anything
 * that had read the user-data envelope, which stays readable through the metadata service for as
 * long as the instance exists — could still write to the machine surface as that workflow.
 *
 * Setting `revoked_at` closes that immediately, and it closes it in the one place both halves
 * consult: `scoped_credentials`. The verifier refuses a revoked row, so a token that is still
 * inside its own `exp` is dead the moment this commits.
 *
 * ## Why it is idempotent and why it returns a count
 *
 * Teardown retries. The reconciler releases leases that teardown never got to. Both revoke, and
 * neither can know whether the other already did — so revoking an already-revoked credential is
 * success, and the count is how a caller distinguishes "I revoked it" from "it was already gone"
 * without that distinction being an error.
 *
 * The `revoked_at` already recorded is **not** overwritten. The first revocation is the one that
 * matters; a retry that moved the timestamp forward would make the audit trail say the credential
 * lived longer than it did.
 */

export interface RevocationOutcome {
  readonly workflowId: string
  /** Credentials this call revoked. Zero when there was nothing live to revoke. */
  readonly revoked: number
  /** Ids revoked by this call, for the teardown record. */
  readonly credentialIds: readonly string[]
}

/**
 * Revoke every live credential for one run.
 *
 * "Every" rather than "the" because `scoped_credentials_live_key` guarantees at most one and this
 * function should not be the thing that discovers the guarantee has been dropped: revoking a set
 * behaves correctly whether the set has one member or two.
 *
 * @param options - The handle, the run, and optionally the moment to record.
 */
export const revokeScopedCredentials = async (options: {
  readonly db: SisyphusDatabase
  readonly workflowId: string
  readonly now?: Date
}): Promise<RevocationOutcome> => {
  const revokedAt = options.now ?? new Date()

  const rows = await options.db
    .update(scopedCredentials)
    .set({ revokedAt })
    // `isNull` is what makes this idempotent: a second call matches nothing and overwrites nothing.
    .where(
      and(
        eq(scopedCredentials.workflowId, options.workflowId),
        isNull(scopedCredentials.revokedAt),
      ),
    )
    .returning({ id: scopedCredentials.id })

  return {
    workflowId: options.workflowId,
    revoked: rows.length,
    credentialIds: rows.map((row) => row.id),
  }
}
