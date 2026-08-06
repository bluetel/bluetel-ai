import { describeTrpcError } from '@sisyphus-admin/components/admin/trpc-error'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import type { RouterOutputs } from '@sisyphus-admin/trpc'

import type { UserActionKind } from './user-actions'

/**
 * What a user change did, and what it means when it was refused.
 *
 * Two rules from US12 live in this module, and both are the kind that get lost in a component:
 *
 * 1. **The never-zero-admins refusal reaches the operator as a field error with a code and a next
 *    action (FR-173, FR-031).** It arrives as `PRECONDITION_FAILED`, which on `admin.users` can
 *    only be that invariant — the role and the target both exist, the caller is an admin, and the
 *    platform's state is the sole reason the change is impossible. Swallowing it into a generic
 *    toast would leave an admin staring at a control that does nothing, so it is mapped to
 *    `E_LAST_ACTIVE_ADMIN` and to the one action that resolves it: promote somebody else first.
 * 2. **A deactivation reports what it left behind (FR-176).** The server flags every non-terminal
 *    run the user owns and returns the count. A silent deactivation that stranded a run is exactly
 *    the failure the requirement exists to prevent, so the count is rendered even when it is zero
 *    — "nothing was stranded" is the answer to the same question.
 */

/** What `setRole` and `setActive` answer with. */
export type UserChangeResult = RouterOutputs['admin']['users']['setActive']

/**
 * The refusal an admin sees when the change would empty the platform of admins.
 *
 * The code is searchable and quotable; the action is what to do, not a restatement of what failed.
 */
export const LAST_ACTIVE_ADMIN_ERROR: FieldErrorContent = {
  code: 'E_LAST_ACTIVE_ADMIN',
  action:
    'Grant the admin role to another active user first, then repeat this change. The platform refuses to be left with none.',
}

/**
 * Describe why a user change was refused.
 *
 * @param error - Whatever the mutation rejected with.
 * @returns A code and a next action, always. `PRECONDITION_FAILED` is the invariant; everything
 *   else falls through to the shared mapping.
 */
export const describeUserChangeError = (error: unknown): FieldErrorContent =>
  describeTrpcError(error, { PRECONDITION_FAILED: LAST_ACTIVE_ADMIN_ERROR })

/** What the panel says after a change succeeded: a state readout and the sentence behind it. */
export interface UserChangeNotice {
  /** For the chip beside the row. `label-mono` uppercases it. */
  readonly readout: string
  readonly detail: string
}

const NO_CHANGE: UserChangeNotice = {
  readout: 'unchanged',
  detail: 'They were already in that state, so nothing was recorded.',
}

const runs = (count: number): string => (count === 1 ? '1 run' : `${String(count)} runs`)

/**
 * Describe what a completed change did.
 *
 * @param kind - Which of the four changes was made.
 * @param result - What the mutation returned.
 */
export const describeUserChange = (
  kind: UserActionKind,
  result: UserChangeResult,
): UserChangeNotice => {
  if (!result.changed) return NO_CHANGE

  const flagged = result.workflowsFlaggedForReassignment

  switch (kind) {
    case 'grant-admin':
      return {
        readout: 'admin granted',
        detail: 'They hold the admin role from their next request onward.',
      }
    case 'revoke-admin':
      return {
        readout: 'admin revoked',
        detail:
          'They lose configuration access from their next request onward, and keep every workflow they own or initiated.',
      }
    case 'deactivate':
      return {
        readout: `flagged ${String(flagged)}`,
        detail:
          flagged === 0
            ? 'They are refused from their next request onward. No run they own was still in flight, so nothing needs a new owner.'
            : `They are refused from their next request onward. ${runs(flagged)} they own ${flagged === 1 ? 'is' : 'are'} still in flight and now flagged for reassignment — those runs keep going, but nobody is accountable for them until an owner is set.`,
      }
    case 'reactivate':
      return {
        readout: `cleared ${String(flagged)}`,
        detail:
          flagged === 0
            ? 'They regain access from their next request onward. No run of theirs was awaiting reassignment.'
            : `They regain access from their next request onward, and the reassignment flag is cleared from ${runs(flagged)}.`,
      }
  }
}
