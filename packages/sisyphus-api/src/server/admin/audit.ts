import type { SQL } from 'drizzle-orm'
import { and, desc, eq, gte, lt, lte } from 'drizzle-orm'
import { z } from 'zod'

import type { ConfigurationAuditEntry, SisyphusDatabase } from '../../db'
import { configurationAudit, users } from '../../db'
import { cursorPagination, dateRange, uuidInput } from '../../schemas'
import { adminProcedure, createTRPCRouter } from '../procedures'

import { AUDITED_ACTIONS, AUDITED_ENTITY_TYPES, readEntityHistory } from './audit-log'
import type { AuditedAction, AuditedEntityType, AuditWriter } from './audit-log'

/**
 * `admin.audit` — **reading** the configuration trail FR-178 has been writing all along.
 *
 * ## Why this exists at all
 *
 * `./audit-log.ts` has recorded every bundle registration and replacement, every workspace and
 * profile edit, every integration change, every grant and revocation, every role change and every
 * owner reassignment since the first of them shipped. Nothing could read it. `/admin/audit`
 * rendered the two trails that *did* have procedures — `admin.users.roleChanges` and
 * `admin.grants.listForUser` — and was blind to everything else, which is a strange shape for an
 * audit view: the write path was complete and the question "who installed this client's
 * credentials" was still unanswerable without a psql session.
 *
 * `contracts/api-surface.md` does not name this procedure. Adding it is a strict extension — it
 * reads a table that already exists, through the vocabulary that already writes it — so it is
 * built to look like the admin lists around it rather than to introduce a second way of listing
 * things.
 *
 * ## What it is built on, and what it deliberately does not restate
 *
 * The two vocabularies come from `./audit-log.ts` by import: {@link AUDITED_ENTITY_TYPES} and
 * {@link AUDITED_ACTIONS} are the *writer's* closed sets, so a filter this router accepts is
 * exactly a value the trail can contain, and adding an entity class in one place cannot leave the
 * reader unable to ask about it. A `z.enum([...])` spelled out here would be a second opinion that
 * compiles.
 *
 * {@link readEntityHistory} is kept and used, not superseded. It answers the narrow question — one
 * entity's whole history, straight off the `(entity_type, entity_id, created_at DESC)` index — and
 * {@link entityHistory} below is the procedure form of it. `list` is the general read, and its
 * conditions are composed so that the fully-narrowed case produces the same rows.
 *
 * ## `adminProcedure`, and why FR-190 has nothing to add here
 *
 * Configuration history is an administrative read: everything in this table is a change to platform
 * configuration made *by* an admin, and FR-169 makes configuration admin-only in both directions.
 * There is no scoped variant to fall back to, because there is no non-admin who is entitled to a
 * subset of it. The one row class that touches a workflow — `owner_reassigned` (FR-132) — is safe
 * for the same reason: an admin already sees every run (FR-183), so naming one in a trail discloses
 * nothing the workflow list would not.
 *
 * ## Nothing here writes
 *
 * The table is append-only. This module exports reads and a router of queries; there is no
 * mutation, and there is nowhere for one to go.
 */

/**
 * The input `admin.audit.list` takes.
 *
 * Built from the shared primitives — `cursorPagination` for the keyset page and `dateRange` for the
 * window — so "what is a valid cursor" and "what is a page limit" stay decided in one place. It
 * lives in this module rather than in `src/schemas/` because it is the only caller of it and
 * because the two enums it needs are the audit writer's, which `src/schemas/` does not import.
 *
 * Every filter is optional and they compose by conjunction, so the empty input is "everything,
 * newest first" and each key added narrows it.
 */
export const listConfigurationAuditInput = cursorPagination.extend({
  ...dateRange.shape,
  entityType: z.enum(AUDITED_ENTITY_TYPES).optional(),
  /**
   * Accepted **without** an entity type, deliberately. Ids are UUIDs and are unique across the
   * platform, so an id alone identifies the thing it names; requiring the class alongside it would
   * make the common case — "paste the id from the row I am looking at" — need a second field the
   * caller has to get right.
   */
  entityId: uuidInput.optional(),
  action: z.enum(AUDITED_ACTIONS).optional(),
  /**
   * The acting admin.
   *
   * A platform-initiated change records **no** actor (`null` — the FR-174 bootstrap reconcile), so
   * any value here excludes those rows rather than matching them. `actor: 'system'` is not a
   * spelling this accepts, because `system` is not a user and a filter that pretended otherwise
   * would put a name on something the trail deliberately leaves unnamed.
   */
  actorUserId: uuidInput.optional(),
})

export type ListConfigurationAuditInput = z.infer<typeof listConfigurationAuditInput>

/**
 * One recorded change, with the acting admin resolved.
 *
 * The actor is joined in rather than left as a bare id, for the same reason `listRoleChanges` does
 * it: a history nobody can read is not the viewable history FR-178 asks for. The join is a `left
 * join` because `actor_user_id` is null for a platform-initiated change, and those rows are part of
 * the trail — dropping them by joining inner would silently hide exactly the changes no human is
 * accountable for.
 */
export interface ConfigurationAuditRow extends Pick<
  ConfigurationAuditEntry,
  'id' | 'entityId' | 'entityVersion' | 'detail' | 'createdAt'
> {
  readonly entityType: AuditedEntityType
  readonly action: AuditedAction
  /** `null` means the platform itself acted (FR-174), not that the actor could not be resolved. */
  readonly actorUserId: string | null
  readonly actorEmail: string | null
  readonly actorDisplayName: string | null
}

/** A page of results plus the cursor that fetches the next one, or `undefined` at the end. */
export interface AuditPage {
  readonly items: readonly ConfigurationAuditRow[]
  readonly nextCursor: string | undefined
}

/**
 * Split an over-fetched row set into a page and its cursor.
 *
 * Reading `limit + 1` rows and discarding the extra is how "is there another page" is answered
 * without a second count query — and a count would be a different snapshot from the page anyway.
 * The same shape `user-queries.ts` and `grant-store.ts` use, so every admin list pages alike.
 */
const toPage = (rows: readonly ConfigurationAuditRow[], limit: number): AuditPage => {
  const items = rows.slice(0, limit)
  return {
    items,
    nextCursor: rows.length > limit ? items[items.length - 1]?.id : undefined,
  }
}

/**
 * Compose the caller's filters.
 *
 * Every clause is optional; `and` of nothing is no restriction, which is what makes the empty input
 * mean "everything" without a branch saying so.
 */
export const listConfigurationAuditConditions = (
  input: ListConfigurationAuditInput,
): SQL | undefined =>
  and(
    // Keyset, on the primary key. Every id in this schema is a UUID v7, which sorts byte for byte
    // in creation order, so `id < cursor` under `order by id desc` is "older than the last row you
    // saw" — a row the caller has actually seen, rather than an offset a concurrent insert shifts.
    input.cursor === undefined ? undefined : lt(configurationAudit.id, input.cursor),
    input.entityType === undefined
      ? undefined
      : eq(configurationAudit.entityType, input.entityType),
    input.entityId === undefined ? undefined : eq(configurationAudit.entityId, input.entityId),
    input.action === undefined ? undefined : eq(configurationAudit.action, input.action),
    input.actorUserId === undefined
      ? undefined
      : eq(configurationAudit.actorUserId, input.actorUserId),
    // Inclusive at both ends. An audit window is quoted to a reader as "the 3rd to the 5th", and a
    // half-open one silently drops whatever happened in the last instant of the range.
    input.from === undefined ? undefined : gte(configurationAudit.createdAt, input.from),
    input.to === undefined ? undefined : lte(configurationAudit.createdAt, input.to),
  )

/** The columns the trail returns. Deliberately not `select *` joined to a whole user row. */
const auditColumns = {
  id: configurationAudit.id,
  entityType: configurationAudit.entityType,
  entityId: configurationAudit.entityId,
  entityVersion: configurationAudit.entityVersion,
  action: configurationAudit.action,
  detail: configurationAudit.detail,
  createdAt: configurationAudit.createdAt,
  actorUserId: configurationAudit.actorUserId,
  actorEmail: users.email,
  actorDisplayName: users.displayName,
} as const

/**
 * Read the configuration trail, newest first (FR-178).
 *
 * `entity_type` and `action` are `text` columns holding a closed vocabulary rather than Postgres
 * enums, so the row's own types are `string`. They are asserted back to the writer's unions here —
 * at the one boundary where the values enter the application — rather than left wide for every
 * consumer to narrow again. What makes the assertion safe is that `recordConfigurationChange` is
 * the sole writer and its parameter types are those unions.
 *
 * @param options.db - The pooled handle. Unscoped and admin-only; see the module comment.
 */
export const listConfigurationAudit = async (options: {
  readonly db: SisyphusDatabase
  readonly input: ListConfigurationAuditInput
}): Promise<AuditPage> => {
  const rows = await options.db
    .select(auditColumns)
    .from(configurationAudit)
    .leftJoin(users, eq(users.id, configurationAudit.actorUserId))
    .where(listConfigurationAuditConditions(options.input))
    .orderBy(desc(configurationAudit.id))
    .limit(options.input.limit + 1)

  return toPage(
    rows.map(
      (row): ConfigurationAuditRow => ({
        ...row,
        entityType: row.entityType as AuditedEntityType,
        action: row.action as AuditedAction,
      }),
    ),
    options.input.limit,
  )
}

/** One entity's whole history, as {@link readEntityHistory} reads it. */
export const entityHistoryInput = z.object({
  entityType: z.enum(AUDITED_ENTITY_TYPES),
  entityId: uuidInput,
  limit: cursorPagination.shape.limit,
})

export type EntityHistoryInput = z.infer<typeof entityHistoryInput>

/**
 * One entity's whole history, straight off the index (FR-178).
 *
 * Kept beside `list` rather than folded into it because it is a different question and has a
 * different answer shape: no cursor, because "everything that ever happened to this bundle" is a
 * bounded list an admin reads in one go, and it is what the panel wants when it is already looking
 * at the entity. It is {@link readEntityHistory} with a procedure around it and nothing else, so
 * the ordering is the `(entity_type, entity_id, created_at DESC)` index's rather than a sort over
 * the whole table.
 */
export const readConfigurationHistory = async (options: {
  readonly db: AuditWriter
  readonly input: EntityHistoryInput
}): Promise<readonly ConfigurationAuditEntry[]> =>
  readEntityHistory(options.db, {
    entityType: options.input.entityType,
    entityId: options.input.entityId,
    limit: options.input.limit,
  })

/**
 * `admin.audit` — the read side of FR-178.
 *
 * Two queries and no mutation. `adminProcedure` throughout: a non-admin's attempt is refused and
 * recorded by the middleware, so nothing in this file re-checks the role.
 */
export const auditRouter = createTRPCRouter({
  /** The whole trail, filtered and keyset-paginated, newest first. */
  list: adminProcedure
    .input(listConfigurationAuditInput)
    .query(
      async ({ ctx, input }): Promise<AuditPage> => listConfigurationAudit({ db: ctx.db, input }),
    ),

  /** One entity's history, off the index, without a cursor. */
  forEntity: adminProcedure
    .input(entityHistoryInput)
    .query(
      async ({ ctx, input }): Promise<readonly ConfigurationAuditEntry[]> =>
        readConfigurationHistory({ db: ctx.db, input }),
    ),
})

export type AuditRouter = typeof auditRouter
