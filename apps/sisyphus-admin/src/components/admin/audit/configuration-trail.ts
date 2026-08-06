import { formatTimestamp } from '@sisyphus-admin/components/admin/format-timestamp'
import type { RouterOutputs } from '@sisyphus-admin/trpc'

import { ACTION_LABELS, ENTITY_TYPE_LABELS } from './configuration-scope'
import type { AuditAction, AuditEntityType } from './configuration-scope'
import { NO_ACTOR } from './grant-trail'

/**
 * Shaping one row of the configuration trail (FR-178).
 *
 * ## What this adds to the two trails already on the screen
 *
 * `grant-trail.ts` shapes access history and `users/role-change-entry.ts` shapes role and
 * activation history. Both are about *people*. This is about everything else the platform can be
 * changed in — a bundle registered, an archive replaced, a workspace edited, an integration
 * enabled or disabled — which until now was written to `configuration_audit` and read by nobody.
 *
 * ## The two things this module refuses to invent
 *
 * **A second timestamp format.** `formatTimestamp` is imported, as every other readout on these
 * pages does it; a private `toISOString().slice(...)` here would be the duplication the qlty gate
 * flags and, worse, a row whose clock disagreed with the row above it.
 *
 * **A second word for "nobody".** A platform-initiated change (FR-174) has a null actor, and the
 * em dash `NO_ACTOR` already means exactly that on the access trail. Reusing it is what keeps one
 * absent-value convention across the screen rather than two that nearly match.
 *
 * ## `detail` is summarised, not rendered
 *
 * The column is `jsonb` and holds whatever made the entry legible when it was written — a digest, a
 * previous and new role, the profile a grant covered. It is shown as its keys, in order, rather
 * than as pretty-printed JSON: an audit row is a line in a list, and a row that expands to twelve
 * is a row nobody scans past. The keys are what tell a reader whether the entry is worth opening
 * the record for.
 */

/** One entry as `admin.audit.list` returns it. */
export type ConfigurationAuditEntry = RouterOutputs['admin']['audit']['list']['items'][number]

/** What one row of the configuration trail shows. */
export interface ConfigurationTrailReadouts {
  readonly id: string
  /** The entity class, in the words an operator uses rather than the column's `snake_case`. */
  readonly entity: string
  readonly entityId: string
  /** `—` where the entity is not versioned; a version number where it is. */
  readonly version: string
  readonly action: string
  readonly at: string
  /** The acting admin's name where there is one, `—` where the platform itself acted (FR-174). */
  readonly actor: string
  /** The keys of the recorded detail, or `—` when nothing was recorded. */
  readonly detail: string
}

/**
 * How an unlabelled value reads.
 *
 * Reachable only if the API's vocabulary gains a member the panel has no label for — which
 * `ENTITY_TYPE_LABELS` makes a compile error, so this is a floor rather than an expected state. It
 * shows the raw value rather than a placeholder, because a reader looking at an audit trail is
 * better served by the unfamiliar word than by nothing.
 */
const labelled = (labels: Readonly<Record<string, string>>, value: string): string =>
  labels[value] ?? value

/** The recorded detail as its keys, comma-separated, or {@link NO_ACTOR} when there is none. */
export const summariseDetail = (detail: unknown): string => {
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) return NO_ACTOR

  const keys = Object.keys(detail as Record<string, unknown>)
  return keys.length === 0 ? NO_ACTOR : keys.join(', ')
}

/**
 * Who acted, as a reader can use it.
 *
 * The display name where the join found one, falling back to the actor's id — an id is worse to
 * read than a name and far better than nothing, because it is what an admin searches the user list
 * with. `—` only for a change the platform made itself, which is a fact about the entry rather
 * than a failure to resolve it.
 */
export const describeActor = (entry: ConfigurationAuditEntry): string =>
  entry.actorUserId === null ? NO_ACTOR : (entry.actorDisplayName ?? entry.actorUserId)

/**
 * Derive the readouts for one recorded change.
 *
 * @param entry - The row as the procedure returned it.
 */
export const toConfigurationTrailReadouts = (
  entry: ConfigurationAuditEntry,
): ConfigurationTrailReadouts => ({
  id: entry.id,
  entity: labelled(ENTITY_TYPE_LABELS, entry.entityType satisfies AuditEntityType),
  entityId: entry.entityId,
  version: entry.entityVersion === null ? NO_ACTOR : String(entry.entityVersion),
  action: labelled(ACTION_LABELS, entry.action satisfies AuditAction),
  at: formatTimestamp(entry.createdAt),
  actor: describeActor(entry),
  detail: summariseDetail(entry.detail),
})
