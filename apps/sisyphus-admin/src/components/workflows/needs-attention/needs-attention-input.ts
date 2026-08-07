import { ACTIVE_WORKFLOW_STATES } from '@bluetel-ai/sisyphus-api/client'
import type { WorkflowState } from '@bluetel-ai/sisyphus-api/client'
import type { RouterInputs, RouterOutputs } from '@sisyphus-admin/trpc'

/**
 * What the needs-attention view actually asks for (T088, FR-134, FR-135, FR-176, FR-190).
 *
 * ## Two questions, and they are different questions
 *
 * FR-135 asks for a view "scoped to the signed-in user's owned workflows, so a person can see what
 * is waiting on them without filtering the whole fleet". That is one query:
 * {@link stoppedForMeInput} — every run **I own** that stopped at `needs_attention`.
 *
 * The second is FR-176's: a run whose owner was deactivated is flagged `needs_reassignment`, and
 * somebody has to give it a new accountable human. That is not "waiting on me" — the person it was
 * waiting on has gone — and `workflow.reassignOwner` is an `adminProcedure`, so it is a queue only
 * an admin can clear. It is a second section on the same page rather than the same list, because
 * merging them would produce a list where half the rows have an action the reader cannot take.
 *
 * ## How the reassignment queue is derived, and why it is derived
 *
 * `workflows.needs_reassignment` is a column, but it is on neither `workflow.list`'s output nor its
 * filter set — the contract exposes it only as `admin.users.list`'s `workflowsAwaitingReassignment`
 * count. So the queue is reconstructed from the two reads that do exist: the deactivated users with
 * a non-zero count, and each of their **non-terminal** runs.
 *
 * That reconstruction is exact rather than approximate, and it is exact because of how the flag is
 * written: `admin.users.setActive(false)` sets it on precisely the non-terminal workflows the
 * deactivated user owns, reactivating clears it, and reassigning clears it by moving the run off
 * them. So "non-terminal runs owned by a deactivated user" and "runs flagged for reassignment" are
 * the same set. It is still a reconstruction, and the honest fix is a `needsReassignment` filter on
 * `workflow.list` — see the note in `needs-attention-panel.tsx`.
 *
 * ## Neither query decides visibility
 *
 * `workflow.list` composes every filter inside the FR-190 base selector, so an owner filter can
 * only narrow what the caller could already see. A run belonging to somebody the caller may not see
 * does not appear here, in a count, or in a total.
 */

/** The `workflow.list` input, inferred. Never a hand-written mirror of the procedure's shape. */
export type ListWorkflowsInput = RouterInputs['workflow']['list']

/** One user as `admin.users.list` returns them. Inferred, never mirrored. */
export type AdministeredUser = RouterOutputs['admin']['users']['list']['items'][number]

/** How many rows one section holds. Bounded by `pageLimit` on the schema; this is well inside it. */
export const NEEDS_ATTENTION_PAGE_SIZE = 25

/**
 * The state a run stops in when it needs a person (FR-135).
 *
 * A single-member list rather than a broader "anything unfinished": `paused` and `parked_resumable`
 * are states somebody chose, and a view that mixed them in would stop being the list of things
 * genuinely waiting on the reader.
 */
export const NEEDS_ATTENTION_STATE: WorkflowState = 'needs_attention'

/**
 * The runs still able to hold compute.
 *
 * Exactly `ACTIVE_WORKFLOW_STATES` rather than a literal list, so this cannot drift from the state
 * machine the next time a state is added — the same rule the reference sweep on the server follows.
 */
export const NON_TERMINAL_STATES: readonly WorkflowState[] = ACTIVE_WORKFLOW_STATES

/**
 * Every run I own that has stopped needing me (FR-135).
 *
 * @param ownerUserId - The signed-in user, resolved on the server by the page. Read from the
 *   session rather than from the URL: a view that took an owner id as a parameter would be a way to
 *   ask "what is waiting on somebody else", which is a different screen with different rules.
 */
export const stoppedForMeInput = (
  ownerUserId: string,
  limit: number = NEEDS_ATTENTION_PAGE_SIZE,
): ListWorkflowsInput => ({ limit, ownerUserId, state: [NEEDS_ATTENTION_STATE] })

/** Every run one deactivated owner still holds, which is the set the flag marks (FR-176). */
export const awaitingReassignmentInput = (
  ownerUserId: string,
  limit: number = NEEDS_ATTENTION_PAGE_SIZE,
): ListWorkflowsInput => ({ limit, ownerUserId, state: [...NON_TERMINAL_STATES] })

/** One deactivated owner with runs nobody is accountable for. */
export interface StrandedOwner {
  readonly userId: string
  readonly displayName: string
  readonly email: string
  /** How many of their runs the platform has flagged, as `admin.users.list` counts them. */
  readonly flaggedCount: number
}

/**
 * The owners whose runs need a new accountable human (FR-176).
 *
 * Deactivated **and** holding at least one flagged run. An active user's count is zero by
 * construction — reactivating clears the flag — so the active check is belt to that braces rather
 * than a second rule.
 */
export const strandedOwners = (users: readonly AdministeredUser[]): readonly StrandedOwner[] =>
  users
    .filter((user) => !user.isActive && user.workflowsAwaitingReassignment > 0)
    .map((user) => ({
      userId: user.id,
      displayName: user.displayName,
      email: user.email,
      flaggedCount: user.workflowsAwaitingReassignment,
    }))

/** The users a run may be reassigned to: active, and not the person it is being taken from. */
export const reassignmentCandidates = (
  users: readonly AdministeredUser[],
  fromUserId: string,
): readonly AdministeredUser[] => users.filter((user) => user.isActive && user.id !== fromUserId)
