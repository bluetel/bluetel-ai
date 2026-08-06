import { describeTrpcError } from '@sisyphus-admin/components/admin'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import type { RouterOutputs } from '@sisyphus-admin/trpc'

/**
 * What the panel says after a run changed hands (T088, FR-031, FR-134, FR-176).
 *
 * ## A no-op is reported, not swallowed
 *
 * `reassignOwner` answers `changed: false` when the run already belongs to the person named. That
 * is an answer to the question the admin asked, and reporting it as a success with no detail would
 * leave them unable to tell "I moved it" from "somebody moved it a minute ago". Both cases produce
 * a notice; only one of them says the flag was cleared.
 */

/** What `workflow.reassignOwner` answers with. Inferred, never mirrored. */
export type ReassignmentResult = RouterOutputs['workflow']['reassignOwner']

/** The state readout and the sentence behind it. */
export interface ReassignmentNotice {
  readonly readout: string
  readonly detail: string
}

/** How much of a run id is shown inline, matching the fleet list rather than inventing a second. */
const RUN_ID_PREVIEW_LENGTH = 8

const abbreviate = (id: string): string =>
  id.length <= RUN_ID_PREVIEW_LENGTH ? id : `${id.slice(0, RUN_ID_PREVIEW_LENGTH)}…`

/**
 * Report a completed reassignment (FR-134, FR-176).
 *
 * @param result - What the mutation answered with.
 * @param ownerName - Who it went to, as the admin chose them. The result carries an id, and an id
 *   is not an answer to "who is accountable now".
 */
export const describeReassignment = (
  result: ReassignmentResult,
  ownerName: string,
): ReassignmentNotice =>
  result.changed
    ? {
        readout: `reassigned ${abbreviate(result.workflow.id)}`,
        detail: `${ownerName} is now accountable for this run, and it is no longer flagged for reassignment. Who moved it and when is on the configuration trail.`,
      }
    : {
        readout: 'unchanged',
        detail: `This run already belonged to ${ownerName}, so nothing moved and nothing was recorded.`,
      }

/**
 * Describe a refused reassignment.
 *
 * `CONFLICT` is worth overriding: on this screen it is always the new owner being unavailable — a
 * deactivated user, or one who no longer exists — and the next action is to pick somebody else
 * rather than to reload and read.
 */
export const describeReassignmentError = (error: unknown): FieldErrorContent =>
  describeTrpcError(error, {
    CONFLICT: {
      code: 'E_OWNER_NOT_AVAILABLE',
      action:
        'Choose an active user — a run cannot be handed to somebody who has been deactivated.',
    },
    NOT_FOUND: {
      code: 'E_WORKFLOW_NOT_FOUND',
      action: 'Reload the page — the run you were reassigning is no longer there.',
    },
    FORBIDDEN: {
      code: 'E_ADMIN_REQUIRED',
      action: 'Ask an active admin to reassign this run.',
    },
  })
