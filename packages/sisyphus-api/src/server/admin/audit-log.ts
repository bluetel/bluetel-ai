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
  /**
   * An agent credential — one identity the platform can work as (003/FR-001).
   *
   * Registration, disable, force-release and every state change are recorded against it
   * (003/FR-004, 003/FR-058). The entity is the credential and never the lease: a lease is a fact
   * *about* a credential over an interval, and an administrator asking "what has happened to this
   * seat" wants one history covering every lease it ever had, not one history per lease.
   */
  'agent_credential',
  /**
   * A credential group — the capacity pool a credential belongs to and profiles attach to
   * (003/FR-060). Creation, rename, disable, deletion, membership changes and every change to a
   * profile's attachments are recorded against it (003/FR-067, 003/SC-013).
   *
   * An attachment change is recorded against the **group** rather than against the profile,
   * deliberately: the group is the scarce thing, and "which profiles were allowed to draw on this
   * pool, and since when" is the question a capacity investigation actually asks. The profile is
   * named in `detail`, so the fact is still reachable from the other side by a reader who wants it.
   */
  'credential_group',
] as const

export type AuditedEntityType = (typeof AUDITED_ENTITY_TYPES)[number]

/**
 * The actions the trail records.
 *
 * `replaced` is distinct from `updated` on purpose: replacing a bundle archive creates a new
 * version and leaves the previous archive immutable (FR-090), which is a different event from
 * editing a row in place.
 *
 * The four credential actions at the end land here **before their first writer exists**, and that
 * is deliberate rather than premature. 003/FR-058 requires every lease acquisition, release, forced
 * release and credential state change to be recorded, and those writers arrive across three later
 * phases in two different workspace members — the control plane's acquire and release, the
 * reconciliation sweep's forced release, the health module's state transitions. Adding a word to
 * this vocabulary is not free: it is an edit to a closed union that every existing caller compiles
 * against. Landing all four in one change, with one review, is what stops the trail acquiring
 * `force_released` in one phase and `forceReleased` in another — a divergence a reader of the table
 * would have to know about to search it correctly, and which no test would catch because both
 * spellings are valid `text`.
 *
 * **`entity_type` and `action` are `text` columns, not Postgres enums** (`db/schema/notify.ts`), so
 * widening either of these tuples ships no migration. They are closed in TypeScript so a typo is a
 * compile error, and open in the database so the vocabulary can grow without an `ALTER TYPE`.
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
  /** A credential was claimed by a workflow, inside the acquiring transaction (003/FR-058). */
  'leased',
  /** A lease ended through the ordinary path, carrying its `release_reason` (003/FR-019). */
  'released',
  /**
   * A lease was taken back from its holder — by an administrator (003/FR-057) or by the
   * reconciliation sweep resolving a run that no longer exists (003/FR-022).
   *
   * Distinct from `released` for the same reason `replaced` is distinct from `updated`: a seat
   * that came free because its run finished and a seat that was taken off a run are different
   * events, and a trail that spelled them the same way could not answer "was anything forced?" —
   * which is the first question asked after a run ends unexpectedly.
   */
  'force_released',
  /**
   * A credential moved between states — `available` to `cooling_off`, `held` to `unhealthy`, and so
   * on (003/FR-058). `detail` names both states; recording only the new one would leave the trail
   * unable to say what a transition was *from*, which is most of what makes it legible.
   */
  'state_changed',
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
