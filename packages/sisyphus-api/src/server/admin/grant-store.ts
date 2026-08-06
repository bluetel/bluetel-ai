import type { SQL } from 'drizzle-orm'
import { and, desc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm'

import type { ProfileAccessGrant, SisyphusDatabase } from '../../db'
import {
  executionProfiles,
  profileAccessGrants,
  users,
  workflows,
  workflowWatchers,
} from '../../db'
import type { UserRole } from '../../enums'

/**
 * Data access for `profile_access_grants` — the table every scoped query reads from.
 *
 * Kept apart from the router in `grants.ts` so the two concerns can be tested separately: the
 * predicates below compile to SQL without a database and are asserted as SQL, while the router
 * tests exercise them against a real Postgres. Splitting them also keeps the FR-188 cascade —
 * the part that is easy to get subtly wrong — in one named place rather than inline in a resolver.
 *
 * Three rules shape this module:
 *
 * 1. **A grant is live when `revoked_at is null`.** Revocation is an update, never a delete, so
 *    the trail survives (FR-184) and the partial unique index on
 *    `(user_id, execution_profile_id) WHERE revoked_at IS NULL` lets a revoked user be granted
 *    again without a duplicate-key failure.
 * 2. **Every function takes a writer rather than importing a handle.** Grant, revoke and the
 *    cascade all run inside the transaction that also writes the audit row, so the change and its
 *    record commit together or not at all.
 * 3. **Pagination is keyset, on the id.** Primary keys are UUID v7, so byte order is time order and
 *    `id desc` is newest-first without a second sort column.
 */

/**
 * Anything that can run the four statement kinds this module issues — the pooled handle or a
 * transaction derived from it. Typed structurally, like `AuditWriter`, so a caller inside
 * `db.transaction(...)` passes the transaction object without a cast.
 */
export type GrantWriter = Pick<SisyphusDatabase, 'delete' | 'insert' | 'select' | 'update'>

/** The pair a grant is identified by. There is at most one live grant per pair. */
export interface GrantTarget {
  readonly userId: string
  readonly executionProfileId: string
}

/** One page of results, plus the cursor that fetches the next one. */
export interface GrantPage<TRow> {
  readonly items: readonly TRow[]
  /** `undefined` when this page is the last one. */
  readonly nextCursor: string | undefined
}

/** A grant as shown on a profile's access list — who holds it. */
export interface ProfileGrantRow {
  readonly id: string
  readonly userId: string
  readonly email: string
  readonly displayName: string
  readonly grantedAt: Date
  readonly grantedByUserId: string
  readonly revokedAt: Date | null
  readonly revokedByUserId: string | null
}

/** A grant as shown on a user's access list — what they hold. */
export interface UserGrantRow {
  readonly id: string
  readonly executionProfileId: string
  readonly profileName: string
  readonly grantedAt: Date
  readonly grantedByUserId: string
  readonly revokedAt: Date | null
  readonly revokedByUserId: string | null
}

/** Matches the single live grant for a pair, if there is one. */
export const liveGrantWhere = (target: GrantTarget): SQL =>
  and(
    eq(profileAccessGrants.userId, target.userId),
    eq(profileAccessGrants.executionProfileId, target.executionProfileId),
    isNull(profileAccessGrants.revokedAt),
  ) ?? sql`false`

/**
 * Watches this user holds that **only** the named grant was keeping alive (FR-188).
 *
 * A watch on a workflow the user owns or initiated survives revocation: those reach them through
 * the ownership clauses of the scope selector, not through the grant, and FR-189 makes being
 * accountable for a run you cannot follow an unacceptable state.
 *
 * `initiated_by_user_id` is nullable — an integration-started run has no initiator — so the
 * comparison is written as "null, or not this user" rather than as a bare `<>`, which would
 * evaluate to null and quietly *keep* the watch on every integration-started workflow.
 */
export const watchesLeftBehindWhere = (target: GrantTarget): SQL =>
  and(
    eq(workflowWatchers.userId, target.userId),
    eq(workflows.executionProfileId, target.executionProfileId),
    ne(workflows.ownerUserId, target.userId),
    or(isNull(workflows.initiatedByUserId), ne(workflows.initiatedByUserId, target.userId)),
  ) ?? sql`false`

/**
 * The role of one user, or `undefined` when no such user exists.
 *
 * One query answering two questions the router asks together: does the target exist at all, and is
 * it an admin — who keeps their watches through a revocation because they see every workflow
 * without a grant (FR-183).
 */
export const readUserRole = async (
  writer: GrantWriter,
  userId: string,
): Promise<UserRole | undefined> => {
  const rows = await writer
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  return rows[0]?.role
}

/** Whether an execution profile exists. Archived profiles still count: their grants are real. */
export const executionProfileExists = async (
  writer: GrantWriter,
  executionProfileId: string,
): Promise<boolean> => {
  const rows = await writer
    .select({ id: executionProfiles.id })
    .from(executionProfiles)
    .where(eq(executionProfiles.id, executionProfileId))
    .limit(1)

  return rows.length > 0
}

/** The live grant for a pair, or `undefined`. */
export const findLiveGrant = async (
  writer: GrantWriter,
  target: GrantTarget,
): Promise<ProfileAccessGrant | undefined> => {
  const rows = await writer
    .select()
    .from(profileAccessGrants)
    .where(liveGrantWhere(target))
    .limit(1)

  return rows[0]
}

/**
 * Insert a new live grant.
 *
 * Callers must have established that no live grant exists for the pair; the partial unique index
 * is the backstop, not the check, because a duplicate-key error surfaced to an admin says nothing
 * useful about what they asked for.
 */
export const insertGrant = async (
  writer: GrantWriter,
  input: GrantTarget & { readonly grantedByUserId: string },
): Promise<ProfileAccessGrant> => {
  const [row] = await writer
    .insert(profileAccessGrants)
    .values({
      userId: input.userId,
      executionProfileId: input.executionProfileId,
      grantedByUserId: input.grantedByUserId,
    })
    .returning()

  return row
}

/** Mark a live grant revoked, keeping the row (FR-184). */
export const markGrantRevoked = async (
  writer: GrantWriter,
  input: {
    readonly grantId: string
    readonly revokedByUserId: string
    readonly revokedAt: Date
  },
): Promise<ProfileAccessGrant> => {
  const [row] = await writer
    .update(profileAccessGrants)
    .set({ revokedAt: input.revokedAt, revokedByUserId: input.revokedByUserId })
    .where(eq(profileAccessGrants.id, input.grantId))
    .returning()

  return row
}

/**
 * Delete the watches the revoked grant was keeping alive, and report how many (FR-188).
 *
 * Selected first and deleted by id rather than deleted with a joined predicate, because a delete
 * cannot join in Postgres without a sub-select and the count is wanted anyway — a revocation that
 * silently kept delivering is the failure this exists to prevent, so the number is returned to the
 * caller and written to the audit detail.
 */
export const removeWatchesLeftBehind = async (
  writer: GrantWriter,
  target: GrantTarget,
): Promise<number> => {
  const stranded = await writer
    .select({ id: workflowWatchers.id })
    .from(workflowWatchers)
    .innerJoin(workflows, eq(workflows.id, workflowWatchers.workflowId))
    .where(watchesLeftBehindWhere(target))

  if (stranded.length === 0) {
    return 0
  }

  await writer.delete(workflowWatchers).where(
    inArray(
      workflowWatchers.id,
      stranded.map((row) => row.id),
    ),
  )

  return stranded.length
}

/** Shared list arguments. `includeRevoked` turns the access list into an access *history*. */
export interface GrantListOptions {
  readonly includeRevoked: boolean
  readonly limit: number
  readonly cursor?: string
}

/** Keyset cursor plus the live-only predicate, in the order the index prefers. */
const listConditions = (options: GrantListOptions): readonly (SQL | undefined)[] => [
  options.includeRevoked ? undefined : isNull(profileAccessGrants.revokedAt),
  options.cursor === undefined ? undefined : lt(profileAccessGrants.id, options.cursor),
]

/** Split an over-fetched result into a page and the cursor that follows it. */
const toPage = <TRow extends { readonly id: string }>(
  rows: readonly TRow[],
  limit: number,
): GrantPage<TRow> => {
  const items = rows.slice(0, limit)
  return {
    items,
    nextCursor: rows.length > limit ? items[items.length - 1]?.id : undefined,
  }
}

/** Who holds — or held — access to one execution profile. */
export const listGrantsForProfile = async (
  writer: GrantWriter,
  options: GrantListOptions & { readonly executionProfileId: string },
): Promise<GrantPage<ProfileGrantRow>> => {
  const rows = await writer
    .select({
      id: profileAccessGrants.id,
      userId: profileAccessGrants.userId,
      email: users.email,
      displayName: users.displayName,
      grantedAt: profileAccessGrants.grantedAt,
      grantedByUserId: profileAccessGrants.grantedByUserId,
      revokedAt: profileAccessGrants.revokedAt,
      revokedByUserId: profileAccessGrants.revokedByUserId,
    })
    .from(profileAccessGrants)
    .innerJoin(users, eq(users.id, profileAccessGrants.userId))
    .where(
      and(
        eq(profileAccessGrants.executionProfileId, options.executionProfileId),
        ...listConditions(options),
      ),
    )
    .orderBy(desc(profileAccessGrants.id))
    .limit(options.limit + 1)

  return toPage(rows, options.limit)
}

/** What one user holds — or held. The other half of the same table, read the other way round. */
export const listGrantsForUser = async (
  writer: GrantWriter,
  options: GrantListOptions & { readonly userId: string },
): Promise<GrantPage<UserGrantRow>> => {
  const rows = await writer
    .select({
      id: profileAccessGrants.id,
      executionProfileId: profileAccessGrants.executionProfileId,
      profileName: executionProfiles.name,
      grantedAt: profileAccessGrants.grantedAt,
      grantedByUserId: profileAccessGrants.grantedByUserId,
      revokedAt: profileAccessGrants.revokedAt,
      revokedByUserId: profileAccessGrants.revokedByUserId,
    })
    .from(profileAccessGrants)
    .innerJoin(executionProfiles, eq(executionProfiles.id, profileAccessGrants.executionProfileId))
    .where(and(eq(profileAccessGrants.userId, options.userId), ...listConditions(options)))
    .orderBy(desc(profileAccessGrants.id))
    .limit(options.limit + 1)

  return toPage(rows, options.limit)
}
