import { and, desc, eq } from 'drizzle-orm'

import type { ConfigurationAuditEntry, SisyphusDatabase } from '../../db'
import { configurationAudit } from '../../db'

/**
 * The configuration audit trail (FR-178).
 *
 * Every change to platform configuration — bundle registration, replacement, enable, disable, and
 * the equivalents for workspaces, profiles, integrations, roles and grants — is written here with
 * the acting admin. The trail is what makes "who installed this client's credentials" answerable
 * after the fact, so a write that silently does not happen is the failure this module exists to
 * prevent.
 *
 * Two rules shape the API:
 *
 * 1. **The writer takes a database handle rather than importing one.** Almost every caller is
 *    already inside a transaction that also performs the change being audited, and the audit row
 *    must live or die with it. A module-level connection would commit the audit row independently
 *    of whether the change succeeded, which is worse than no trail at all.
 * 2. **`actorUserId` is nullable and that is meaningful, not lax.** `null` means the platform
 *    itself acted — the deploy-time bootstrap-admin reconcile (FR-174) has no human behind it.
 *    Callers acting on behalf of a signed-in admin must pass their id; `system` is not a fallback
 *    for "I did not thread the actor through".
 */

/**
 * Anything that can execute a Drizzle insert against the audit table — the pooled database handle
 * or a transaction derived from it. Typed structurally so a caller inside `db.transaction(...)`
 * can pass the transaction object without a cast.
 */
export type AuditWriter = Pick<SisyphusDatabase, 'insert' | 'select'>

/** The entity classes the trail covers. Closed, so a typo becomes a compile error. */
export const AUDITED_ENTITY_TYPES = [
  'setup_bundle',
  'workspace',
  'execution_profile',
  'integration',
  'user',
  'profile_access_grant',
  /**
   * A workflow is not configuration, but reassigning its owner is an administrative act with the
   * same "who did this, and when" question behind it (FR-132) — so it belongs in the same trail
   * rather than in a second one nobody thinks to read.
   */
  'workflow',
] as const

export type AuditedEntityType = (typeof AUDITED_ENTITY_TYPES)[number]

/**
 * The actions the trail records.
 *
 * `replaced` is distinct from `updated` on purpose: replacing a bundle archive creates a new
 * version and leaves the previous archive immutable (FR-090), which is a different event from
 * editing a row in place.
 */
export const AUDITED_ACTIONS = [
  'registered',
  'replaced',
  'updated',
  'enabled',
  'disabled',
  'granted',
  'revoked',
  'role_changed',
  'activated',
  'deactivated',
  'owner_reassigned',
] as const

export type AuditedAction = (typeof AUDITED_ACTIONS)[number]

/** One configuration change, as recorded. */
export interface ConfigurationChange {
  /** The admin who acted, or `null` for a platform-initiated change (FR-174). */
  readonly actorUserId: string | null
  readonly entityType: AuditedEntityType
  readonly entityId: string
  /** The version this change produced, where the entity is versioned. */
  readonly entityVersion?: number
  readonly action: AuditedAction
  /**
   * Whatever makes the entry legible later — the bundle digest, the previous and new role, the
   * profile a grant covers. Must never carry a credential or an archive's contents: this table is
   * readable by every admin, and a secret written here outlives the secret rotation that follows.
   */
  readonly detail?: Record<string, unknown>
}

/**
 * Write one configuration change to the trail.
 *
 * Pass the surrounding transaction as `writer` whenever there is one, so the audit row and the
 * change it describes commit together.
 */
export const recordConfigurationChange = async (
  writer: AuditWriter,
  change: ConfigurationChange,
): Promise<void> => {
  await writer.insert(configurationAudit).values({
    actorUserId: change.actorUserId,
    entityType: change.entityType,
    entityId: change.entityId,
    entityVersion: change.entityVersion ?? null,
    action: change.action,
    detail: change.detail ?? null,
  })
}

/** How far back to read when a caller does not say. */
const DEFAULT_HISTORY_LIMIT = 50

export interface EntityHistoryQuery {
  readonly entityType: AuditedEntityType
  readonly entityId: string
  readonly limit?: number
}

/**
 * Read one entity's change history, newest first.
 *
 * Backed by the `(entity_type, entity_id, created_at DESC)` index, so the ordering is the index's
 * rather than a sort over the whole table.
 */
export const readEntityHistory = async (
  writer: AuditWriter,
  query: EntityHistoryQuery,
): Promise<ConfigurationAuditEntry[]> =>
  writer
    .select()
    .from(configurationAudit)
    .where(
      and(
        eq(configurationAudit.entityType, query.entityType),
        eq(configurationAudit.entityId, query.entityId),
      ),
    )
    .orderBy(desc(configurationAudit.createdAt))
    .limit(query.limit ?? DEFAULT_HISTORY_LIMIT)
