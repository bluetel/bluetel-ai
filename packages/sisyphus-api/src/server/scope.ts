import { TRPCError } from '@trpc/server'
import type { SQL } from 'drizzle-orm'
import { and, count, eq, inArray, isNull, or, sql } from 'drizzle-orm'

import type { SisyphusDatabase, Workflow } from '../db'
import { profileAccessGrants, workflows } from '../db'

import { memoiseAsync } from './memoise'

/**
 * Access scoping — the single place FR-190 is enforced.
 *
 * FR-190 forbids disclosing a workflow outside the requester's scope **including its existence**,
 * so counts and aggregates are in scope as much as reads are: a total that includes an invisible
 * workflow discloses that it exists. That rules out a per-resolver check. Instead the request
 * context carries one resolver, and every workflow query composes from the one base selector this
 * module exports ({@link visibleWorkflowsFilter}). A resolver that builds its own `where` from
 * scratch has re-derived the rule, and the failure mode when it gets it wrong is silence.
 *
 * The resolver is **memoised rather than resolved eagerly** because most requests never consult
 * the scope: the health check does not, and the executor's high-frequency machine calls are
 * authorised by a workflow-scoped credential rather than by a profile grant. Resolving eagerly
 * would put a `profile_access_grants` query on the hot path of every one of them.
 */

/** Who is asking, reduced to the two facts the scope depends on. */
export interface ScopeIdentity {
  readonly userId: string
  /** Admins see everything (FR-181), so their scope needs no grants query at all. */
  readonly isAdmin: boolean
}

/** The caller's visible set, resolved once per request. */
export interface ResolvedScope {
  readonly userId: string
  readonly isAdmin: boolean
  /**
   * Profiles the caller holds a live grant on. Empty for an admin — deliberately, because
   * {@link visibleWorkflowsFilter} short-circuits on `isAdmin` and never reads this. An empty
   * array here does **not** mean "sees nothing": the ownership clauses still apply (FR-189).
   */
  readonly visibleProfileIds: readonly string[]
}

/**
 * The lazily-resolved scope carried on the request context.
 *
 * `resolve` is idempotent within a request: the first call runs the grants query and every later
 * call returns the same result, so composing ten scoped queries costs one query, not ten.
 */
export interface ScopeResolver {
  readonly resolve: () => Promise<ResolvedScope>
}

/**
 * Wrap a loader so it runs at most once per request.
 *
 * The *promise* is memoised rather than its result, so two resolvers awaiting concurrently share
 * a single in-flight query instead of racing two. A rejection is memoised too, and that is
 * intended: a request whose grants query failed must not silently retry into a different answer
 * halfway through building a response.
 *
 * @param load - Runs the underlying lookup. Called at most once.
 */
export const memoiseScope = (load: () => Promise<ResolvedScope>): ScopeResolver => ({
  resolve: memoiseAsync(load),
})

/**
 * Read the profiles a user holds a live grant on.
 *
 * A grant is live when `revoked_at is null` (FR-184), so revocation takes effect at the next
 * request without touching history — and without affecting workflows the user owns or initiated,
 * which reach them through the ownership clauses instead (FR-188, FR-189).
 */
export const loadGrantedProfileIds = async (
  db: SisyphusDatabase,
  userId: string,
): Promise<readonly string[]> => {
  const rows = await db
    .select({ executionProfileId: profileAccessGrants.executionProfileId })
    .from(profileAccessGrants)
    .where(and(eq(profileAccessGrants.userId, userId), isNull(profileAccessGrants.revokedAt)))

  return rows.map((row) => row.executionProfileId)
}

/**
 * Build the request's scope resolver.
 *
 * Nothing is queried here — the returned resolver is inert until something composes a scoped
 * query from it.
 */
export const createScopeResolver = (options: {
  readonly db: SisyphusDatabase
  readonly identity: ScopeIdentity
}): ScopeResolver =>
  memoiseScope(async () => ({
    userId: options.identity.userId,
    isAdmin: options.identity.isAdmin,
    visibleProfileIds: options.identity.isAdmin
      ? []
      : await loadGrantedProfileIds(options.db, options.identity.userId),
  }))

/**
 * The resolver used when there is no active session.
 *
 * Public and machine-surface requests still carry a `scope` field so the context shape is uniform,
 * but resolving one is a programming error rather than an authorisation outcome — a scoped read
 * reached without a session means a procedure was built on the wrong base.
 */
export const createUnauthenticatedScopeResolver = (): ScopeResolver =>
  memoiseScope(() =>
    Promise.reject(
      new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Not signed in.',
      }),
    ),
  )

/**
 * A workflow the caller may not see is reported as **absent**, never as forbidden.
 *
 * `FORBIDDEN` answers "does this workflow exist?" with yes, which is exactly the disclosure FR-190
 * prohibits. This is the single most easily-broken rule in the contract — `FORBIDDEN` is the
 * intuitive code and it is wrong — so it is asserted in `scope.test.ts` rather than left to review.
 * The message names no id, no owner and no profile.
 */
export const workflowNotFoundError = (): TRPCError =>
  new TRPCError({ code: 'NOT_FOUND', message: 'Workflow not found.' })

/**
 * **The base selector.** Every workflow read, count and aggregate composes from this.
 *
 * Three ways in, matching data-model.md → Access scoping:
 *
 * 1. an admin sees everything (FR-181);
 * 2. a live grant on the workflow's execution profile (FR-179, FR-183);
 * 3. owning or having initiated the run (FR-189) — not a convenience. An integration-started
 *    workflow is owned by a ticket assignee who may hold no grant at all, and being accountable
 *    for a run you can neither see nor stop is not shippable (FR-191).
 */
export const visibleWorkflowsFilter = (scope: ResolvedScope): SQL => {
  if (scope.isAdmin) {
    return sql`true`
  }

  const grantClause =
    scope.visibleProfileIds.length > 0
      ? inArray(workflows.executionProfileId, [...scope.visibleProfileIds])
      : undefined

  const visible = or(
    grantClause,
    eq(workflows.ownerUserId, scope.userId),
    eq(workflows.initiatedByUserId, scope.userId),
  )

  // `or` is typed as possibly-undefined because every clause may be. Two of ours never are, so
  // this fallback is unreachable — it exists so the return type is `SQL` and callers compose
  // without a null check, which is what stops a scoped query being written unscoped by accident.
  return visible ?? sql`false`
}

/**
 * Compose the base selector with a resolver's own conditions.
 *
 * This is the only supported way to add a filter to a workflow query: the scope clause goes in
 * first and cannot be dropped by editing the caller's conditions.
 */
export const scopedWorkflowWhere = (
  scope: ResolvedScope,
  ...conditions: readonly (SQL | undefined)[]
): SQL => {
  const base = visibleWorkflowsFilter(scope)
  return and(base, ...conditions) ?? base
}

/** Arguments shared by every scoped read in this module. */
export interface ScopedReadOptions {
  readonly db: SisyphusDatabase
  readonly scope: ResolvedScope
}

/**
 * Fetch one workflow, or `undefined` when it does not exist **or** is out of scope.
 *
 * The two cases are indistinguishable on purpose: a caller that could tell them apart could
 * enumerate workflow ids (FR-190).
 */
export const findWorkflowInScope = async (
  options: ScopedReadOptions & { readonly workflowId: string },
): Promise<Workflow | undefined> => {
  const rows = await options.db
    .select()
    .from(workflows)
    .where(scopedWorkflowWhere(options.scope, eq(workflows.id, options.workflowId)))
    .limit(1)

  return rows[0]
}

/**
 * Fetch one workflow or throw {@link workflowNotFoundError}.
 *
 * Every `scopedProcedure` resolver that takes a `workflowId` starts here, so no resolver decides
 * for itself which error code an out-of-scope target deserves.
 */
export const requireWorkflowInScope = async (
  options: ScopedReadOptions & { readonly workflowId: string },
): Promise<Workflow> => {
  const workflow = await findWorkflowInScope(options)
  if (workflow === undefined) {
    throw workflowNotFoundError()
  }
  return workflow
}

/**
 * Count workflows within scope.
 *
 * Aggregates compose from the same selector as reads: a count that includes an invisible workflow
 * discloses its existence just as effectively as returning the row would (FR-190, SC-051).
 */
export const countWorkflowsInScope = async (
  options: ScopedReadOptions & { readonly conditions?: readonly (SQL | undefined)[] },
): Promise<number> => {
  const rows = await options.db
    .select({ value: count() })
    .from(workflows)
    .where(scopedWorkflowWhere(options.scope, ...(options.conditions ?? [])))

  return rows[0]?.value ?? 0
}

/**
 * List workflow ids within scope, newest first.
 *
 * Exists so the panel's list and the reconciler share one scoped id set rather than each
 * rebuilding a `where` clause.
 */
export const listWorkflowIdsInScope = async (
  options: ScopedReadOptions & {
    readonly conditions?: readonly (SQL | undefined)[]
    readonly limit?: number
  },
): Promise<readonly string[]> => {
  const rows = await options.db
    .select({ id: workflows.id })
    .from(workflows)
    .where(scopedWorkflowWhere(options.scope, ...(options.conditions ?? [])))
    .orderBy(workflows.createdAt)
    .limit(options.limit ?? 100)

  return rows.map((row) => row.id)
}
