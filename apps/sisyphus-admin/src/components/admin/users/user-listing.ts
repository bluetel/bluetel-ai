import { formatTimestamp } from '@sisyphus-admin/components/admin/format-timestamp'
import type { RouterOutputs } from '@sisyphus-admin/trpc'

/**
 * Shaping a `admin.users.list` row into the readouts the card renders (FR-171).
 *
 * The type comes from `RouterOutputs`, never from a hand-written DTO: a mirrored interface is
 * duplication the qlty gate flags, and it drifts silently — nothing fails when the procedure adds
 * a column and the copy does not.
 *
 * Everything a row shows is derived **here** rather than inside the JSX, because these are the
 * decisions worth asserting. A count rendered as an empty string, a `null` last-sign-in rendered
 * as `Invalid Date`, or a reassignment backlog quietly omitted when it is zero are all bugs that a
 * component test cannot see and a table of inputs and outputs can.
 */

/** One user as `admin.users.list` returns them. */
export type AdministeredUser = RouterOutputs['admin']['users']['list']['items'][number]

/** What a user card puts on screen. */
export interface UserReadouts {
  readonly displayName: string
  readonly email: string
  /** `admin` or `engineer`, as the chip readout. */
  readonly role: string
  /** `active` or `inactive`. Not a workflow state, so it is a plain readout, not a state colour. */
  readonly activity: string
  readonly lastSignIn: string
  readonly ownedRuns: string
  /**
   * Runs this user owns that are already flagged for a new owner (FR-176), or `undefined` when
   * there are none — a `0` here would put a permanent zero on every well-behaved row and train
   * the eye to skip the column that matters.
   */
  readonly awaitingReassignment: string | undefined
}

/**
 * Whether this user is the kind of account a deactivation would strand work behind.
 *
 * Not a rule the panel enforces — the server owns the never-zero-admins invariant — but the reason
 * the card shows owned-run counts next to the deactivate control rather than in a separate tab.
 */
export const hasWorkInFlight = (user: AdministeredUser): boolean => user.ownedWorkflowCount > 0

/**
 * Derive the readouts for one row.
 *
 * @param user - The row as the procedure returned it.
 */
export const toUserReadouts = (user: AdministeredUser): UserReadouts => ({
  displayName: user.displayName,
  email: user.email,
  role: user.role,
  activity: user.isActive ? 'active' : 'inactive',
  lastSignIn: formatTimestamp(user.lastSignInAt),
  ownedRuns: String(user.ownedWorkflowCount),
  awaitingReassignment:
    user.workflowsAwaitingReassignment > 0 ? String(user.workflowsAwaitingReassignment) : undefined,
})
