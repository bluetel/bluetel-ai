import type { SQL } from 'drizzle-orm'
import { and, desc, eq, getTableName, ilike, lt, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import type { RoleChange, SisyphusDatabase, User } from '../../db'
import { roleChanges, users, workflows } from '../../db'
import type { ListRoleChangesInput, ListUsersInput } from '../../schemas'

/**
 * The two reads behind `admin.users` — who exists (FR-171) and how that changed (FR-177).
 *
 * Both paginate by keyset on the primary key rather than by offset. Every id in the schema is a
 * UUID v7, which sorts byte for byte in creation order, so `order by id desc` **is** newest-first and
 * the cursor is a row the caller has actually seen. An offset would re-read rows that a concurrent
 * insert had shifted, which on a newest-first list is every row on every page.
 */

/** The columns of `users` the admin surface returns. Deliberately not `select *`. */
export const administeredUserColumns = {
  id: users.id,
  email: users.email,
  displayName: users.displayName,
  role: users.role,
  isActive: users.isActive,
  slackUserId: users.slackUserId,
  lastSignInAt: users.lastSignInAt,
  createdAt: users.createdAt,
} as const

/** One user as the admin surface sees them. */
export type AdministeredUser = Pick<
  User,
  | 'id'
  | 'email'
  | 'displayName'
  | 'role'
  | 'isActive'
  | 'slackUserId'
  | 'lastSignInAt'
  | 'createdAt'
>

/**
 * A user in the list, with the ownership figures FR-171 asks for.
 *
 * `workflowsAwaitingReassignment` is the queue side of FR-176: deactivating someone flags the runs
 * they own, and an admin needs to see the flag count against the person to know what taking them
 * off the platform actually left behind.
 */
export interface AdministeredUserListing extends AdministeredUser {
  readonly ownedWorkflowCount: number
  readonly workflowsAwaitingReassignment: number
}

/** A page of results plus the cursor that fetches the next one, or `undefined` at the end. */
export interface Page<TItem> {
  readonly items: readonly TItem[]
  readonly nextCursor: string | undefined
}

/**
 * Split an over-fetched row set into a page and its cursor.
 *
 * Reading `limit + 1` rows and discarding the extra is how "is there another page" is answered
 * without a second count query — and a count would be a different snapshot from the page anyway.
 */
const toPage = <TItem extends { readonly id: string }>(
  rows: readonly TItem[],
  limit: number,
): Page<TItem> => {
  const items = rows.slice(0, limit)
  return {
    items,
    nextCursor: rows.length > limit ? items[items.length - 1]?.id : undefined,
  }
}

/**
 * Escape a user-supplied search term for the case-insensitive pattern match.
 *
 * Without this a search for `100%` matches every user, and `_` silently becomes a wildcard. The
 * backslash is doubled first so an escape character in the term cannot escape the escaping.
 */
const escapeLikeTerm = (term: string): string =>
  term.replace(/\\/g, '\\\\').replace(/[%_]/g, (character) => `\\${character}`)

/**
 * Count of workflows a user owns, as a correlated subquery.
 *
 * A subquery rather than a `left join` + `group by`: joining would multiply the user row by its
 * workflows and force every selected column into the grouping, and the second count below would
 * need a filtered aggregate on top of that.
 *
 * **The outer reference is written out by hand, and has to be.** Drizzle renders a column embedded
 * in a `sql` template *unqualified*, so `${users.id}` becomes `"id"` — which inside this subquery
 * resolves to `workflows.id`, comparing an owner to a workflow and silently counting zero. It is a
 * wrong answer rather than an error, which is why the counts are asserted against seeded rows in
 * the live tests.
 */
const outerUserId = sql`${sql.identifier(getTableName(users))}.${sql.identifier(users.id.name)}`

const ownedWorkflowCount = sql<number>`(
  select count(*)::int from ${workflows} where ${workflows.ownerUserId} = ${outerUserId}
)`

const workflowsAwaitingReassignment = sql<number>`(
  select count(*)::int from ${workflows}
   where ${workflows.ownerUserId} = ${outerUserId} and ${workflows.needsReassignment}
)`

/** Compose the caller's filters. Every clause is optional; `and` of nothing is no restriction. */
const listUsersConditions = (input: ListUsersInput): SQL | undefined => {
  const pattern = input.search === undefined ? undefined : `%${escapeLikeTerm(input.search)}%`

  return and(
    input.cursor === undefined ? undefined : lt(users.id, input.cursor),
    input.activeOnly ? eq(users.isActive, true) : undefined,
    input.role === undefined ? undefined : eq(users.role, input.role),
    // `email` is `citext`, so a case-insensitive match on it is redundant but harmless;
    // `display_name` is plain text and genuinely needs one.
    pattern === undefined
      ? undefined
      : or(ilike(users.email, pattern), ilike(users.displayName, pattern)),
  )
}

/**
 * Every known user, newest first, with their role, active state, last sign-in and owned-run counts
 * (FR-171).
 *
 * Unscoped by design and only reachable through `adminProcedure`: an admin sees every user, and
 * the user list is not workflow data, so FR-190's visible-set filter has nothing to say about it.
 */
export const listUsers = async (options: {
  readonly db: SisyphusDatabase
  readonly input: ListUsersInput
}): Promise<Page<AdministeredUserListing>> => {
  const rows = await options.db
    .select({ ...administeredUserColumns, ownedWorkflowCount, workflowsAwaitingReassignment })
    .from(users)
    .where(listUsersConditions(options.input))
    .orderBy(desc(users.id))
    .limit(options.input.limit + 1)

  return toPage(rows, options.input.limit)
}

/**
 * One entry of the append-only role and activation history (FR-177).
 *
 * The actor's and subject's identities are joined in rather than left as bare ids, because a
 * history nobody can read is not the viewable history the requirement asks for. `actor` is a
 * `left join` because `actor_user_id` is null for the deploy-time bootstrap reconcile — the
 * `system` actor of FR-174.
 */
export interface RoleChangeEntry extends Pick<
  RoleChange,
  'id' | 'change' | 'reason' | 'createdAt'
> {
  readonly actorUserId: string | null
  readonly actorEmail: string | null
  readonly actorDisplayName: string | null
  readonly subjectUserId: string
  readonly subjectEmail: string
  readonly subjectDisplayName: string
}

/**
 * Read the role and activation history, newest first.
 *
 * Nothing in this module writes to `role_changes` and nothing anywhere updates or deletes from it:
 * the table is append-only, which is what makes the history uneditable rather than merely
 * un-edited (FR-177).
 */
export const listRoleChanges = async (options: {
  readonly db: SisyphusDatabase
  readonly input: ListRoleChangesInput
}): Promise<Page<RoleChangeEntry>> => {
  const actor = alias(users, 'actor')
  const subject = alias(users, 'subject')
  const { cursor, limit, subjectUserId } = options.input

  const rows = await options.db
    .select({
      id: roleChanges.id,
      change: roleChanges.change,
      reason: roleChanges.reason,
      createdAt: roleChanges.createdAt,
      actorUserId: roleChanges.actorUserId,
      actorEmail: actor.email,
      actorDisplayName: actor.displayName,
      subjectUserId: roleChanges.subjectUserId,
      subjectEmail: subject.email,
      subjectDisplayName: subject.displayName,
    })
    .from(roleChanges)
    .leftJoin(actor, eq(actor.id, roleChanges.actorUserId))
    .innerJoin(subject, eq(subject.id, roleChanges.subjectUserId))
    .where(
      and(
        cursor === undefined ? undefined : lt(roleChanges.id, cursor),
        subjectUserId === undefined ? undefined : eq(roleChanges.subjectUserId, subjectUserId),
      ),
    )
    .orderBy(desc(roleChanges.id))
    .limit(limit + 1)

  return toPage(rows, limit)
}

/** Exported for the tests that prove a wildcard character cannot reach the pattern unescaped. */
export const escapeSearchTerm = escapeLikeTerm

/** Exported so the pagination contract is testable without a database. */
export const paginate = toPage
