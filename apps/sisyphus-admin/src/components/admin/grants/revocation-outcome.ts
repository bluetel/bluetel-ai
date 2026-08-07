import { describeTrpcError } from '@sisyphus-admin/components/admin/trpc-error'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import type { RouterOutputs } from '@sisyphus-admin/trpc'

/**
 * What revoking a grant does, said **before** it is confirmed and reported after (FR-188).
 *
 * Revocation cascades: the server removes every workflow watch the grant was the sole basis for,
 * and returns the count. A count shown only afterwards is a report — the admin has already acted.
 * So this module has two halves:
 *
 * - {@link describeRevocationCascade} states the rule at confirmation time. It cannot state the
 *   *number*, because there is no procedure that previews it, and the count is only true at the
 *   instant the transaction runs anyway. What it can state precisely is which watches go and which
 *   stay, and that is the part an admin needs in order to decide.
 * - {@link describeRevocationResult} reports what actually happened, including zero.
 *
 * The asymmetry is deliberate and worth reading before adding a "this will remove N watches"
 * preview: an exact count computed a moment earlier is a number that can be wrong by the time the
 * button is pressed, which is worse than a rule that is always true.
 */

/** What `grants.revoke` answers with. */
export type GrantRevoked = RouterOutputs['admin']['grants']['revoke']

/** What `grants.grant` answers with. */
export type GrantIssued = RouterOutputs['admin']['grants']['grant']

/** The state readout and the sentence behind it. */
export interface GrantNotice {
  readonly readout: string
  readonly detail: string
}

const watches = (count: number): string => (count === 1 ? '1 watch' : `${String(count)} watches`)

/**
 * What revocation will do, stated before the admin confirms it.
 *
 * @param holder - Who holds the grant, for a sentence that names a person rather than a row.
 * @returns The consequences, one per line, in the order they matter.
 */
export const describeRevocationCascade = (holder: string): readonly string[] => [
  `${holder} loses the ability to launch on this profile at their next request. Access is checked per request, so it does not wait for a session to expire.`,
  'Workflows already in flight are untouched. A run they own or initiated stays visible to them, they can still pause, correct and stop it, and their name stays on its history.',
  'Watches they hold on this profile’s workflows are removed — but only the ones this grant was keeping alive. A watch on a run they own or initiated survives, because that never rested on the grant.',
  'The grant is not deleted. It is stamped with the time and who revoked it, and stays in the access history; granting again later is an ordinary operation.',
]

/**
 * Report what a completed revocation removed.
 *
 * Zero is reported as loudly as three. An admin who only ever sees a notice when something was
 * removed learns to skim it, and then misses the one that mattered.
 */
export const describeRevocationResult = (result: GrantRevoked): GrantNotice => ({
  readout: `watches removed ${String(result.watchesRemoved)}`,
  detail:
    result.watchesRemoved === 0
      ? 'Access revoked. No watch was resting on this grant, so nothing was removed — an admin keeps their watches regardless, because they see every workflow without holding a grant.'
      : `Access revoked, and ${watches(result.watchesRemoved)} the grant was keeping alive ${result.watchesRemoved === 1 ? 'was' : 'were'} removed. Watches on runs they own or initiated were kept.`,
})

/** Report what issuing a grant did, including the case where it changed nothing. */
export const describeGrantResult = (result: GrantIssued): GrantNotice =>
  result.created
    ? {
        readout: 'granted',
        detail:
          'They can launch on this profile, and see its workflows, from their next request onward.',
      }
    : {
        readout: 'already held',
        detail:
          'They already held a live grant on this profile, so nothing was written and nothing was recorded. Granting twice is a duplicate request, not an error.',
      }

/**
 * Describe a refused grant or revocation.
 *
 * `NOT_FOUND` is the one that matters. An unknown user, an unknown profile and a pair with no live
 * grant all come back as the *same* error with the *same* message, deliberately, so the router
 * cannot be used to enumerate ids (FR-190). The panel's rendering keeps that promise: the action
 * says nothing about which of the three it was, and never says "permission".
 */
export const describeGrantError = (error: unknown): FieldErrorContent =>
  describeTrpcError(error, {
    NOT_FOUND: {
      code: 'E_GRANT_TARGET_NOT_FOUND',
      action: 'Reload the access list and pick again — that user, profile or grant is not there.',
    },
  })
