import { formatTimestamp } from '@sisyphus-admin/components/admin/format-timestamp'
import type { RouterOutputs } from '@sisyphus-admin/trpc'

/**
 * Shaping one line of the append-only role and activation history (FR-177).
 *
 * The table is append-only and nothing anywhere updates or deletes from it, so this is a read and
 * only a read. Two details are worth naming:
 *
 * - **`actorUserId` is null for the deploy-time bootstrap reconcile** — the `system` actor of
 *   FR-174, which is how the first admin exists without an admin to create them. Rendering that as
 *   a blank cell would make the most important row in the history look like missing data.
 * - **A reason is optional**, and an absent one is stated rather than left as an empty line: "no
 *   reason recorded" is a fact about the history, whereas whitespace is ambiguous.
 */

/** One entry as `admin.users.roleChanges` returns it. */
export type RoleChangeEntry = RouterOutputs['admin']['users']['roleChanges']['items'][number]

/** What the history renders per row. */
export interface RoleChangeReadouts {
  readonly id: string
  /** The change, spaced for the mono readout: `grant admin`, `deactivate`. */
  readonly change: string
  /** Who acted, or `system` for the bootstrap reconcile. */
  readonly actor: string
  readonly subject: string
  readonly at: string
  readonly reason: string
}

/** How the history names the deploy-time reconcile that establishes the first admin (FR-174). */
export const SYSTEM_ACTOR = 'system'

/** What an entry with no stated reason reads as. */
export const NO_REASON = 'no reason recorded'

/**
 * Derive the readouts for one history entry.
 *
 * @param entry - The entry as the procedure returned it.
 */
export const toRoleChangeReadouts = (entry: RoleChangeEntry): RoleChangeReadouts => ({
  id: entry.id,
  change: entry.change.replace(/_/g, ' '),
  actor: entry.actorDisplayName ?? entry.actorEmail ?? SYSTEM_ACTOR,
  subject: entry.subjectDisplayName,
  at: formatTimestamp(entry.createdAt),
  reason: entry.reason ?? NO_REASON,
})
