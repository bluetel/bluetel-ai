import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm'

import type { SisyphusDatabase, Workspace, WorkspaceEntry, WorkspaceVersion } from '../../db'
import {
  executionProfiles,
  executionProfileVersions,
  integrationMappings,
  integrations,
  workflows,
  workspaceEntries,
  workspaces,
  workspaceVersions,
} from '../../db'
import { ACTIVE_WORKFLOW_STATES } from '../../enums'

import type { Page } from './user-queries'
import type { NormalisedWorkspaceEntry } from './workspace-entries'

/**
 * Data access for `workspaces`, `workspace_versions` and `workspace_entries`.
 *
 * Kept apart from the router in `workspaces.ts` for the reason `bundle-store.ts` is kept apart from
 * `bundles.ts`: the parts that are easy to get wrong — allocating a version number under a lock,
 * the reference sweep, the "entries of the current version" reduction — belong in one named place
 * with their own test.
 *
 * Three rules shape this module, and they are the same three `bundle-store.ts` states because they
 * are the same requirement seen twice:
 *
 * 1. **Nothing here ever updates a `workspace_versions` or `workspace_entries` row.** There is no
 *    `updateVersion` and no `replaceEntries`, and their absence is the point. FR-125 requires an
 *    edit to create a new version leaving in-flight runs untouched — a workflow pinned to version 3
 *    must still resolve version 3's entries after an edit publishes version 4. An `update` on
 *    `workspace_entries` would defeat a schema that already models this correctly.
 * 2. **The version number is allocated under a row lock.** See {@link lockWorkspaceForVersioning}.
 * 3. **Every function takes a writer rather than importing a handle**, so an insert and the audit
 *    row it belongs with commit together — the same argument as `AuditWriter` in `./audit-log`.
 */

/**
 * Anything that can run the statements this module issues — the pooled handle or a transaction
 * derived from it. Typed structurally, like `AuditWriter` and `BundleWriter`, so a caller inside
 * `db.transaction(...)` passes the transaction object without a cast.
 */
export type WorkspaceStoreWriter = Pick<
  SisyphusDatabase,
  'select' | 'selectDistinctOn' | 'insert' | 'update' | 'execute'
>

/** One published entry set, as the panel sees it. */
export interface WorkspaceVersionSummary {
  readonly id: string
  readonly version: number
  readonly createdByUserId: string
  readonly createdAt: Date
  readonly entries: readonly WorkspaceEntry[]
}

/** One workspace as `workspaces.list` returns it. */
export interface WorkspaceListing {
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly enabled: boolean
  readonly archivedAt: Date | null
  readonly createdAt: Date
  /**
   * The version a launch would pin right now, with its entries.
   *
   * `undefined` only for a workspace whose creating transaction is mid-flight. It is deliberately
   * the version `current_version_id` points at rather than the highest version number: advancing
   * that pointer is what publishing an edit *is* (FR-125), and `max(version)` would show a version
   * that no run can be launched against.
   */
  readonly currentVersion: WorkspaceVersionSummary | undefined
  /** How many versions exist, so the panel can offer the history without fetching it. */
  readonly versionCount: number
}

/** What the list query is filtered by. */
export interface ListWorkspacesQuery {
  readonly enabledOnly: boolean
  readonly includeArchived: boolean
  readonly limit: number
  readonly cursor?: string
}

/**
 * The first row, honestly typed.
 *
 * `noUncheckedIndexedAccess` is off in this project, so `rows[0]` is typed as present even when the
 * result set is empty. Going through a function whose declared return type admits `undefined`
 * restores the check.
 */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/**
 * Split an over-fetched row set into a page and its cursor. Reading `limit + 1` rows answers "is
 * there another page" without a second count query taken from a different snapshot.
 */
const toPage = <TItem extends { readonly id: string }>(
  rows: readonly TItem[],
  limit: number,
): Page<TItem> => {
  const items = rows.slice(0, limit)
  return { items, nextCursor: rows.length > limit ? items[items.length - 1]?.id : undefined }
}

/** The workspace columns the panel reads. Deliberately not `select *`. */
const workspaceColumns = {
  id: workspaces.id,
  name: workspaces.name,
  description: workspaces.description,
  enabled: workspaces.enabled,
  currentVersionId: workspaces.currentVersionId,
  archivedAt: workspaces.archivedAt,
  createdAt: workspaces.createdAt,
} as const

/**
 * Every entry of the named versions, grouped by version and in position order.
 *
 * One query for the whole page rather than one per workspace: a list of twenty workspaces would
 * otherwise be twenty-one round trips, and the entries are the part of a workspace an admin is
 * actually looking at.
 */
export const readEntriesByVersion = async (
  writer: WorkspaceStoreWriter,
  workspaceVersionIds: readonly string[],
): Promise<Map<string, WorkspaceEntry[]>> => {
  if (workspaceVersionIds.length === 0) {
    return new Map()
  }

  const rows = await writer
    .select()
    .from(workspaceEntries)
    .where(inArray(workspaceEntries.workspaceVersionId, [...workspaceVersionIds]))
    .orderBy(asc(workspaceEntries.workspaceVersionId), asc(workspaceEntries.position))

  const grouped = new Map<string, WorkspaceEntry[]>()
  for (const row of rows) {
    const existing = grouped.get(row.workspaceVersionId)
    if (existing === undefined) {
      grouped.set(row.workspaceVersionId, [row])
    } else {
      existing.push(row)
    }
  }
  return grouped
}

/** The entries of one version, in position order. The read a running workflow's detail view makes. */
export const readVersionEntries = async (
  writer: WorkspaceStoreWriter,
  workspaceVersionId: string,
): Promise<readonly WorkspaceEntry[]> =>
  writer
    .select()
    .from(workspaceEntries)
    .where(eq(workspaceEntries.workspaceVersionId, workspaceVersionId))
    .orderBy(asc(workspaceEntries.position))

/** How many versions each of the named workspaces has. */
const readVersionCounts = async (
  writer: WorkspaceStoreWriter,
  workspaceIds: readonly string[],
): Promise<Map<string, number>> => {
  if (workspaceIds.length === 0) {
    return new Map()
  }

  const rows = await writer
    .select({
      workspaceId: workspaceVersions.workspaceId,
      total: sql<number>`count(*)::int`,
    })
    .from(workspaceVersions)
    .where(inArray(workspaceVersions.workspaceId, [...workspaceIds]))
    .groupBy(workspaceVersions.workspaceId)

  return new Map(rows.map((row) => [row.workspaceId, row.total]))
}

/**
 * A page of workspaces, each with the version a launch would pin and that version's entries.
 *
 * Keyset paginated on the primary key: every id is a UUID v7, so byte order is creation order and
 * `id desc` is newest-first without a second sort column.
 */
export const listWorkspaces = async (
  writer: WorkspaceStoreWriter,
  query: ListWorkspacesQuery,
): Promise<Page<WorkspaceListing>> => {
  const filters = [
    query.enabledOnly ? eq(workspaces.enabled, true) : undefined,
    query.includeArchived ? undefined : isNull(workspaces.archivedAt),
    query.cursor === undefined ? undefined : lt(workspaces.id, query.cursor),
  ].filter((filter) => filter !== undefined)

  const rows = await writer
    .select(workspaceColumns)
    .from(workspaces)
    .where(filters.length === 0 ? undefined : and(...filters))
    .orderBy(desc(workspaces.id))
    .limit(query.limit + 1)

  const page = toPage(rows, query.limit)
  const currentVersionIds = page.items
    .map((workspace) => workspace.currentVersionId)
    .filter((id) => id !== null)

  const [versions, entries, versionCounts] = await Promise.all([
    currentVersionIds.length === 0
      ? Promise.resolve([] as WorkspaceVersion[])
      : writer
          .select()
          .from(workspaceVersions)
          .where(inArray(workspaceVersions.id, currentVersionIds)),
    readEntriesByVersion(writer, currentVersionIds),
    readVersionCounts(
      writer,
      page.items.map((workspace) => workspace.id),
    ),
  ])

  const versionsById = new Map(versions.map((version) => [version.id, version]))

  return {
    items: page.items.map(({ currentVersionId, ...workspace }): WorkspaceListing => {
      const version = currentVersionId === null ? undefined : versionsById.get(currentVersionId)

      return {
        ...workspace,
        currentVersion:
          version === undefined
            ? undefined
            : {
                id: version.id,
                version: version.version,
                createdByUserId: version.createdByUserId,
                createdAt: version.createdAt,
                entries: entries.get(version.id) ?? [],
              },
        versionCount: versionCounts.get(workspace.id) ?? 0,
      }
    }),
    nextCursor: page.nextCursor,
  }
}

/** One workspace by id, or `undefined`. */
export const findWorkspace = async (
  writer: WorkspaceStoreWriter,
  workspaceId: string,
): Promise<Workspace | undefined> =>
  firstRow(await writer.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1))

/**
 * One workspace by name, or `undefined`.
 *
 * Used to turn the unique-index violation a duplicate name would otherwise produce into a refusal
 * that names the problem. `name` is plain `text`, so the comparison is case-sensitive and matches
 * the index exactly — a check that lower-cased here would refuse names the database would accept.
 */
export const findWorkspaceByName = async (
  writer: WorkspaceStoreWriter,
  name: string,
): Promise<Workspace | undefined> =>
  firstRow(await writer.select().from(workspaces).where(eq(workspaces.name, name)).limit(1))

/** One version by id, or `undefined`. */
export const findWorkspaceVersion = async (
  writer: WorkspaceStoreWriter,
  workspaceVersionId: string,
): Promise<WorkspaceVersion | undefined> =>
  firstRow(
    await writer
      .select()
      .from(workspaceVersions)
      .where(eq(workspaceVersions.id, workspaceVersionId))
      .limit(1),
  )

/**
 * Lock the workspace row and report the highest version number published against it.
 *
 * **Must be called inside a transaction.** Two admins editing the same workspace at the same moment
 * would otherwise both read `max(version) = 3` and both try to insert version 4; the unique index
 * on `(workspace_id, version)` would turn the loser into a duplicate-key error rather than into
 * version 5. `for update` on the parent row makes the loser wait and then re-read, so the second
 * edit is an ordinary operation and not a retry.
 *
 * The lock is taken on `workspaces`, not on the version rows: there is no row to lock for the
 * version that does not exist yet, and the parent is the one row both callers are certain to
 * contend on.
 *
 * @returns `undefined` when there is no such workspace, otherwise the current highest version — `0`
 *   for a workspace with no versions at all.
 */
export const lockWorkspaceForVersioning = async (
  writer: WorkspaceStoreWriter,
  workspaceId: string,
): Promise<{ readonly workspace: Workspace; readonly highestVersion: number } | undefined> => {
  const workspace = firstRow(
    await writer
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)
      .for('update'),
  )

  if (workspace === undefined) {
    return undefined
  }

  const highest = firstRow(
    await writer
      .select({ highest: sql<number>`coalesce(max(${workspaceVersions.version}), 0)::int` })
      .from(workspaceVersions)
      .where(eq(workspaceVersions.workspaceId, workspaceId)),
  )

  return { workspace, highestVersion: highest?.highest ?? 0 }
}

export interface InsertWorkspaceInput {
  readonly name: string
  readonly description: string | undefined
}

/** Insert the parent row. Disabled by default — enabling is a separate, audited act (FR-127). */
export const insertWorkspace = async (
  writer: WorkspaceStoreWriter,
  input: InsertWorkspaceInput,
): Promise<Workspace> => {
  const row = firstRow(
    await writer
      .insert(workspaces)
      .values({ name: input.name, description: input.description ?? null })
      .returning(),
  )

  if (row === undefined) {
    throw new Error('Inserting a workspace returned no row.')
  }
  return row
}

export interface InsertWorkspaceVersionInput {
  readonly workspaceId: string
  readonly version: number
  readonly createdByUserId: string
  readonly entries: readonly NormalisedWorkspaceEntry[]
}

/** A published version and the entries that hang off it. */
export interface PublishedWorkspaceVersion {
  readonly version: WorkspaceVersion
  readonly entries: readonly WorkspaceEntry[]
}

/**
 * Insert one immutable version and its entries.
 *
 * There is no upsert and no `onConflictDoUpdate` here on purpose. A conflict on
 * `(workspace_id, version)` means two callers raced past the lock above, and the correct outcome is
 * a loud failure rather than one entry set silently replacing another (FR-125).
 *
 * The entries are inserted against the **new** version id, which is what makes an edit invisible to
 * a run that pinned an earlier one.
 */
export const insertWorkspaceVersion = async (
  writer: WorkspaceStoreWriter,
  input: InsertWorkspaceVersionInput,
): Promise<PublishedWorkspaceVersion> => {
  const version = firstRow(
    await writer
      .insert(workspaceVersions)
      .values({
        workspaceId: input.workspaceId,
        version: input.version,
        createdByUserId: input.createdByUserId,
      })
      .returning(),
  )

  if (version === undefined) {
    throw new Error('Inserting a workspace version returned no row.')
  }

  const entries = await writer
    .insert(workspaceEntries)
    .values(
      input.entries.map((entry) => ({
        workspaceVersionId: version.id,
        repositoryUrl: entry.repositoryUrl,
        baseBranch: entry.baseBranch,
        subdirectory: entry.subdirectory,
        isPrimary: entry.isPrimary,
        position: entry.position,
      })),
    )
    .returning()

  return { version, entries }
}

export interface UpdateWorkspaceFields {
  readonly name?: string
  readonly description?: string | null
  readonly enabled?: boolean
  /** Advanced by publishing a version. Never rewound — an earlier version stays resolvable. */
  readonly currentVersionId?: string
  /**
   * The soft delete. A workspace referenced by an integration or a non-terminal workflow must never
   * reach this field — see {@link readWorkspaceReferences}; disabling is what FR-128 offers instead.
   */
  readonly archivedAt?: Date | null
}

/**
 * Update the mutable parent row.
 *
 * Cannot reach a version or an entry — the type has no field for either, so "update the workspace"
 * is not a path by which a published entry set can be mutated (FR-125).
 */
export const updateWorkspace = async (
  writer: WorkspaceStoreWriter,
  workspaceId: string,
  fields: UpdateWorkspaceFields,
): Promise<Workspace | undefined> =>
  firstRow(
    await writer
      .update(workspaces)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(workspaces.id, workspaceId))
      .returning(),
  )

/** An execution profile that pins one of this workspace's versions. */
export interface WorkspaceProfileReference {
  readonly executionProfileId: string
  readonly name: string
  readonly enabled: boolean
}

/** An integration whose mappings can start work under one of those profiles. */
export interface WorkspaceIntegrationReference {
  readonly integrationId: string
  readonly name: string
  readonly enabled: boolean
}

/**
 * Everything that would break if this workspace went away (FR-128).
 *
 * `archivable` is the requirement stated as a boolean: a workspace referenced by an integration or
 * by a workflow that is not yet in a terminal state must be **disabled**, never deleted. Execution
 * profiles alone do not block archiving — an archived workspace whose profiles are disabled is a
 * legitimate end state — but they are reported, because an admin about to disable a workspace needs
 * to know which launch presets stop working.
 */
export interface WorkspaceReferences {
  readonly executionProfiles: readonly WorkspaceProfileReference[]
  readonly integrations: readonly WorkspaceIntegrationReference[]
  /** Workflows still holding, or still able to hold, compute against this workspace. */
  readonly activeWorkflowCount: number
  readonly totalWorkflowCount: number
  readonly archivable: boolean
}

/**
 * Read the reference sweep.
 *
 * "Non-terminal" is {@link ACTIVE_WORKFLOW_STATES} rather than a literal list: it is exactly
 * `WORKFLOW_STATES` minus `TERMINAL_WORKFLOW_STATES`, and restating it here would let the two drift
 * the next time a state is added.
 */
export const readWorkspaceReferences = async (
  writer: WorkspaceStoreWriter,
  workspaceId: string,
): Promise<WorkspaceReferences> => {
  const profileRows = await writer
    .selectDistinctOn([executionProfiles.id], {
      executionProfileId: executionProfiles.id,
      name: executionProfiles.name,
      enabled: executionProfiles.enabled,
    })
    .from(executionProfileVersions)
    .innerJoin(
      workspaceVersions,
      eq(executionProfileVersions.workspaceVersionId, workspaceVersions.id),
    )
    .innerJoin(
      executionProfiles,
      eq(executionProfileVersions.executionProfileId, executionProfiles.id),
    )
    .where(eq(workspaceVersions.workspaceId, workspaceId))
    .orderBy(executionProfiles.id)

  const integrationRows =
    profileRows.length === 0
      ? []
      : await writer
          .selectDistinctOn([integrations.id], {
            integrationId: integrations.id,
            name: integrations.name,
            enabled: integrations.enabled,
          })
          .from(integrationMappings)
          .innerJoin(integrations, eq(integrationMappings.integrationId, integrations.id))
          .where(
            inArray(
              integrationMappings.executionProfileId,
              profileRows.map((profile) => profile.executionProfileId),
            ),
          )
          .orderBy(integrations.id)

  const counts = firstRow(
    await writer
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (
          where ${inArray(workflows.state, [...ACTIVE_WORKFLOW_STATES])}
        )::int`,
      })
      .from(workflows)
      .innerJoin(workspaceVersions, eq(workflows.workspaceVersionId, workspaceVersions.id))
      .where(eq(workspaceVersions.workspaceId, workspaceId)),
  )

  const activeWorkflowCount = counts?.active ?? 0

  return {
    executionProfiles: profileRows,
    integrations: integrationRows,
    activeWorkflowCount,
    totalWorkflowCount: counts?.total ?? 0,
    archivable: activeWorkflowCount === 0 && integrationRows.length === 0,
  }
}
