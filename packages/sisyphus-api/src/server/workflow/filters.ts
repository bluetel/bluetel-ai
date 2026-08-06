import type { SQL } from 'drizzle-orm'
import { and, eq, exists, ilike, inArray, lt, or } from 'drizzle-orm'

import type { SisyphusDatabase } from '../../db'
import { setupBundleVersions, workflowEntries, workflows, workspaceVersions } from '../../db'
import type { ListWorkflowsInput } from '../../schemas'

/**
 * The `where` fragments `workflow.list` narrows with — and nothing else.
 *
 * **Nothing in this module is a scope check.** Everything here composes *inside*
 * {@link import('../scope').scopedWorkflowWhere}, which puts the FR-190 base selector first; a
 * filter can therefore only ever narrow what the caller could already see. Keeping the two apart
 * is deliberate: the moment a filter builder is allowed to decide visibility, the visibility rule
 * has been re-derived in a second place and the failure mode when it disagrees is silence
 * (FR-013, FR-190).
 *
 * Every fragment is written to stay on an index at the platform's target history volume
 * (FR-013, SC-050):
 *
 * - the four id filters hit `workflows_profile_state_idx`, `workflows_owner_state_idx` and
 *   `workflows_integration_idx` directly;
 * - the two version-indirected filters (workspace, setup bundle) resolve to an `in (…)` over a
 *   small version set rather than to a join that would multiply the driving table;
 * - the repository filter is an `exists` against `workflow_entries_repository_branch_idx`, so a
 *   multi-repo run is matched without the row fan-out a join produces;
 * - the cursor is a keyset predicate on the primary key, never an offset.
 */

/**
 * Escape a caller-supplied search term for the case-insensitive pattern match.
 *
 * Without this a search for `100%` matches every workflow and `_` silently becomes a wildcard. The
 * backslash is doubled first, so an escape character inside the term cannot escape the escaping.
 */
export const escapeSearchTerm = (term: string): string =>
  term.replace(/\\/g, '\\\\').replace(/[%_]/g, (character) => `\\${character}`)

/**
 * Which columns `search` looks at.
 *
 * Deliberately the two short, human-authored identifiers a person actually remembers a run by. The
 * assembled prompt is **not** searched: it is unbounded text with no index, so including it would
 * turn every search into a sequential scan of the whole history — the one thing FR-013's
 * responsiveness clause rules out — and it is also the column most likely to carry ticket content
 * a reader of the list has no other route to.
 */
const searchCondition = (term: string): SQL | undefined => {
  const pattern = `%${escapeSearchTerm(term)}%`
  return or(ilike(workflows.ticketReference, pattern), ilike(workflows.resultBranchName, pattern))
}

/** Workflows whose pinned workspace version belongs to one workspace. */
const workspaceCondition = (db: SisyphusDatabase, workspaceId: string): SQL =>
  inArray(
    workflows.workspaceVersionId,
    db
      .select({ id: workspaceVersions.id })
      .from(workspaceVersions)
      .where(eq(workspaceVersions.workspaceId, workspaceId)),
  )

/** Workflows whose pinned bundle version belongs to one setup bundle. */
const setupBundleCondition = (db: SisyphusDatabase, setupBundleId: string): SQL =>
  inArray(
    workflows.setupBundleVersionId,
    db
      .select({ id: setupBundleVersions.id })
      .from(setupBundleVersions)
      .where(eq(setupBundleVersions.setupBundleId, setupBundleId)),
  )

/**
 * Workflows with an entry on one repository (FR-013).
 *
 * `exists` rather than a join, because a workflow with several entries would otherwise appear
 * once per matching entry and the page would silently hold fewer than `limit` distinct runs.
 */
const repositoryCondition = (db: SisyphusDatabase, repositoryUrl: string): SQL =>
  exists(
    db
      .select({ one: workflowEntries.id })
      .from(workflowEntries)
      .where(
        and(
          eq(workflowEntries.workflowId, workflows.id),
          eq(workflowEntries.repositoryUrl, repositoryUrl),
        ),
      ),
  )

/**
 * Compose every filter the caller asked for, and nothing more.
 *
 * Returns `undefined` when nothing was filtered, which is the correct input to
 * `scopedWorkflowWhere` — `and` of nothing is no restriction, and the scope clause still applies.
 *
 * @param db - Needed only to build the two version-indirected subqueries.
 * @param input - The validated `workflow.list` input.
 */
export const workflowListConditions = (
  db: SisyphusDatabase,
  input: ListWorkflowsInput,
): SQL | undefined =>
  and(
    // Keyset, not offset. Every id is a UUID v7, so it sorts byte for byte in creation order and
    // `id < cursor` with `order by id desc` is exactly "the page after the last row you saw".
    // An offset would re-read rows a concurrent insert had shifted, which on a newest-first list
    // is every row on every page.
    input.cursor === undefined ? undefined : lt(workflows.id, input.cursor),
    input.initiatedByUserId === undefined
      ? undefined
      : eq(workflows.initiatedByUserId, input.initiatedByUserId),
    input.ownerUserId === undefined ? undefined : eq(workflows.ownerUserId, input.ownerUserId),
    input.originatingIntegrationId === undefined
      ? undefined
      : eq(workflows.originatingIntegrationId, input.originatingIntegrationId),
    input.executionProfileId === undefined
      ? undefined
      : eq(workflows.executionProfileId, input.executionProfileId),
    input.setupBundleId === undefined ? undefined : setupBundleCondition(db, input.setupBundleId),
    input.workspaceId === undefined ? undefined : workspaceCondition(db, input.workspaceId),
    input.repositoryUrl === undefined ? undefined : repositoryCondition(db, input.repositoryUrl),
    input.type === undefined ? undefined : eq(workflows.type, input.type),
    input.state === undefined ? undefined : inArray(workflows.state, [...input.state]),
    input.search === undefined ? undefined : searchCondition(input.search),
  )

/** A page of results plus the cursor that fetches the next one, or `undefined` at the end. */
export interface WorkflowPage<TItem> {
  readonly items: readonly TItem[]
  readonly nextCursor: string | undefined
}

/**
 * Split an over-fetched row set into a page and its cursor.
 *
 * Reading `limit + 1` rows and discarding the extra answers "is there another page" without a
 * second query. A `count(*)` would be both a second index-wide read and a different snapshot from
 * the page itself — and under FR-190 it would also have to be scoped, so the cheap version is the
 * correct one twice over.
 */
export const toWorkflowPage = <TItem extends { readonly id: string }>(
  rows: readonly TItem[],
  limit: number,
): WorkflowPage<TItem> => {
  const items = rows.slice(0, limit)
  return {
    items,
    nextCursor: rows.length > limit ? items[items.length - 1]?.id : undefined,
  }
}
