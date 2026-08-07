import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm'

import type {
  ExecutionProfile,
  ExecutionProfileVersion,
  SisyphusDatabase,
  WorkspaceEntry,
} from '../../db'
import {
  executionProfiles,
  executionProfileVersions,
  integrationMappings,
  integrations,
  profileAccessGrants,
  setupBundles,
  setupBundleVersions,
  workflows,
  workspaceEntries,
  workspaces,
  workspaceVersions,
} from '../../db'
import type { ClaudeModel, PurchaseMode, WorkflowType } from '../../enums'
import { ACTIVE_WORKFLOW_STATES } from '../../enums'

import type { Page } from './user-queries'

/**
 * Data access for `execution_profiles` and `execution_profile_versions`.
 *
 * Kept apart from the router in `profiles.ts` for the reason `bundle-store.ts` is kept apart from
 * `bundles.ts`, and shaped by the same three rules:
 *
 * 1. **Nothing here ever updates an `execution_profile_versions` row.** Every launch value lives on
 *    the version, and `workflows.execution_profile_version_id` is what reconstructs a run's exact
 *    configuration for the whole retention period (FR-065, FR-126). An `update` on a version would
 *    make that reconstruction a description of a later edit.
 * 2. **The version number is allocated under a row lock.** See {@link lockProfileForVersioning}.
 * 3. **Every function takes a writer rather than importing a handle**, so an insert and the audit
 *    row it belongs with commit together.
 *
 * A version pins the **bundle version and workspace version**, not their parent ids. That is what
 * makes FR-124's gate meaningful: a profile that was validated against one bundle version has not
 * been silently re-pointed at another by somebody replacing an archive.
 */

/** Anything that can run the statements this module issues — the pooled handle or a transaction. */
export type ProfileStoreWriter = Pick<
  SisyphusDatabase,
  'select' | 'selectDistinctOn' | 'insert' | 'update' | 'execute'
>

/** One profile as `profiles.list` returns it. */
export interface ProfileListing {
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly enabled: boolean
  readonly archivedAt: Date | null
  readonly createdAt: Date
  /**
   * The version a launch would pin right now.
   *
   * Deliberately the version `current_version_id` points at rather than the highest version number:
   * advancing that pointer is what publishing an edit *is* (FR-125), and `loadLaunchableProfileVersion`
   * in `../workflow/start.ts` reads the same pointer. A list that showed `max(version)` would offer
   * a configuration no run could be started from.
   */
  readonly currentVersion: ExecutionProfileVersion | undefined
  readonly versionCount: number
}

/** What the list query is filtered by. */
export interface ListProfilesQuery {
  readonly enabledOnly: boolean
  readonly includeArchived: boolean
  readonly limit: number
  readonly cursor?: string
}

/**
 * The first row, honestly typed. `noUncheckedIndexedAccess` is off in this project, so `rows[0]` is
 * typed as present even when the result set is empty.
 */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/** Split an over-fetched row set into a page and its cursor. */
const toPage = <TItem extends { readonly id: string }>(
  rows: readonly TItem[],
  limit: number,
): Page<TItem> => {
  const items = rows.slice(0, limit)
  return { items, nextCursor: rows.length > limit ? items[items.length - 1]?.id : undefined }
}

/** The profile columns the panel reads. Deliberately not `select *`. */
const profileColumns = {
  id: executionProfiles.id,
  name: executionProfiles.name,
  description: executionProfiles.description,
  enabled: executionProfiles.enabled,
  currentVersionId: executionProfiles.currentVersionId,
  archivedAt: executionProfiles.archivedAt,
  createdAt: executionProfiles.createdAt,
} as const

/** How many versions each of the named profiles has. */
const readVersionCounts = async (
  writer: ProfileStoreWriter,
  executionProfileIds: readonly string[],
): Promise<Map<string, number>> => {
  if (executionProfileIds.length === 0) {
    return new Map()
  }

  const rows = await writer
    .select({
      executionProfileId: executionProfileVersions.executionProfileId,
      total: sql<number>`count(*)::int`,
    })
    .from(executionProfileVersions)
    .where(inArray(executionProfileVersions.executionProfileId, [...executionProfileIds]))
    .groupBy(executionProfileVersions.executionProfileId)

  return new Map(rows.map((row) => [row.executionProfileId, row.total]))
}

/**
 * A page of profiles, each with the version a launch would pin.
 *
 * Keyset paginated on the primary key: every id is a UUID v7, so byte order is creation order and
 * `id desc` is newest-first without a second sort column.
 */
export const listProfiles = async (
  writer: ProfileStoreWriter,
  query: ListProfilesQuery,
): Promise<Page<ProfileListing>> => {
  const filters = [
    query.enabledOnly ? eq(executionProfiles.enabled, true) : undefined,
    query.includeArchived ? undefined : isNull(executionProfiles.archivedAt),
    query.cursor === undefined ? undefined : lt(executionProfiles.id, query.cursor),
  ].filter((filter) => filter !== undefined)

  const rows = await writer
    .select(profileColumns)
    .from(executionProfiles)
    .where(filters.length === 0 ? undefined : and(...filters))
    .orderBy(desc(executionProfiles.id))
    .limit(query.limit + 1)

  const page = toPage(rows, query.limit)
  const currentVersionIds = page.items
    .map((profile) => profile.currentVersionId)
    .filter((id) => id !== null)

  const [versions, versionCounts] = await Promise.all([
    currentVersionIds.length === 0
      ? Promise.resolve([] as ExecutionProfileVersion[])
      : writer
          .select()
          .from(executionProfileVersions)
          .where(inArray(executionProfileVersions.id, currentVersionIds)),
    readVersionCounts(
      writer,
      page.items.map((profile) => profile.id),
    ),
  ])

  const versionsById = new Map(versions.map((version) => [version.id, version]))

  return {
    items: page.items.map(
      ({ currentVersionId, ...profile }): ProfileListing => ({
        ...profile,
        currentVersion: currentVersionId === null ? undefined : versionsById.get(currentVersionId),
        versionCount: versionCounts.get(profile.id) ?? 0,
      }),
    ),
    nextCursor: page.nextCursor,
  }
}

/** One profile by id, or `undefined`. */
export const findProfile = async (
  writer: ProfileStoreWriter,
  executionProfileId: string,
): Promise<ExecutionProfile | undefined> =>
  firstRow(
    await writer
      .select()
      .from(executionProfiles)
      .where(eq(executionProfiles.id, executionProfileId))
      .limit(1),
  )

/**
 * One profile by name, or `undefined`.
 *
 * Case-sensitive, matching the unique index exactly — a check that lower-cased here would refuse
 * names the database would accept.
 */
export const findProfileByName = async (
  writer: ProfileStoreWriter,
  name: string,
): Promise<ExecutionProfile | undefined> =>
  firstRow(
    await writer.select().from(executionProfiles).where(eq(executionProfiles.name, name)).limit(1),
  )

/** One version by id, or `undefined`. */
export const findProfileVersion = async (
  writer: ProfileStoreWriter,
  executionProfileVersionId: string,
): Promise<ExecutionProfileVersion | undefined> =>
  firstRow(
    await writer
      .select()
      .from(executionProfileVersions)
      .where(eq(executionProfileVersions.id, executionProfileVersionId))
      .limit(1),
  )

/**
 * Lock the profile row and report the highest version number published against it.
 *
 * **Must be called inside a transaction**, for the reason `lockBundleForVersioning` must be: two
 * admins editing the same profile would otherwise both compute the same next version number and
 * the loser would hit `execution_profile_versions_version_key` instead of producing version n+2.
 *
 * @returns `undefined` when there is no such profile, otherwise the highest version — `0` for a
 *   profile with none.
 */
export const lockProfileForVersioning = async (
  writer: ProfileStoreWriter,
  executionProfileId: string,
): Promise<{ readonly profile: ExecutionProfile; readonly highestVersion: number } | undefined> => {
  const profile = firstRow(
    await writer
      .select()
      .from(executionProfiles)
      .where(eq(executionProfiles.id, executionProfileId))
      .limit(1)
      .for('update'),
  )

  if (profile === undefined) {
    return undefined
  }

  const highest = firstRow(
    await writer
      .select({ highest: sql<number>`coalesce(max(${executionProfileVersions.version}), 0)::int` })
      .from(executionProfileVersions)
      .where(eq(executionProfileVersions.executionProfileId, executionProfileId)),
  )

  return { profile, highestVersion: highest?.highest ?? 0 }
}

export interface InsertProfileInput {
  readonly name: string
  readonly description: string | undefined
}

/** Insert the parent row. Disabled by default — enabling runs the FR-124 gate separately. */
export const insertProfile = async (
  writer: ProfileStoreWriter,
  input: InsertProfileInput,
): Promise<ExecutionProfile> => {
  const row = firstRow(
    await writer
      .insert(executionProfiles)
      .values({ name: input.name, description: input.description ?? null })
      .returning(),
  )

  if (row === undefined) {
    throw new Error('Inserting an execution profile returned no row.')
  }
  return row
}

/** Every launch value a version carries (FR-121). Snapshotted whole, never referenced by pointer. */
export interface InsertProfileVersionInput {
  readonly executionProfileId: string
  readonly version: number
  readonly workspaceVersionId: string
  readonly setupBundleVersionId: string
  readonly model: ClaudeModel
  readonly instanceType: string
  readonly purchaseMode: PurchaseMode
  readonly turnCap: number | null
  readonly spendCap: string | null
  readonly defaultWorkflowType: WorkflowType
  readonly promptPreamble: string | null
  readonly lockedFields: readonly string[]
  readonly createdByUserId: string
}

/**
 * Insert one immutable version.
 *
 * No upsert and no `onConflictDoUpdate`: a conflict on `(execution_profile_id, version)` means two
 * callers raced past the lock, and the correct outcome is a loud failure rather than one launch
 * configuration silently replacing another (FR-125).
 */
export const insertProfileVersion = async (
  writer: ProfileStoreWriter,
  input: InsertProfileVersionInput,
): Promise<ExecutionProfileVersion> => {
  const row = firstRow(
    await writer
      .insert(executionProfileVersions)
      .values({ ...input, lockedFields: [...input.lockedFields] })
      .returning(),
  )

  if (row === undefined) {
    throw new Error('Inserting an execution profile version returned no row.')
  }
  return row
}

export interface UpdateProfileFields {
  readonly name?: string
  readonly description?: string | null
  readonly enabled?: boolean
  /** Advanced by publishing a version. */
  readonly currentVersionId?: string
  /** The soft delete. A referenced profile must never reach this field (FR-128). */
  readonly archivedAt?: Date | null
}

/**
 * Update the mutable parent row.
 *
 * Cannot reach a version — the type has no field for one, so "update the profile" is not a path by
 * which a published launch configuration can be mutated (FR-125).
 */
export const updateProfile = async (
  writer: ProfileStoreWriter,
  executionProfileId: string,
  fields: UpdateProfileFields,
): Promise<ExecutionProfile | undefined> =>
  firstRow(
    await writer
      .update(executionProfiles)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(executionProfiles.id, executionProfileId))
      .returning(),
  )

/**
 * Everything FR-124's gate needs to judge one profile version, read in two queries.
 *
 * Read as data and judged separately — see `profile-gate.ts` — so the rule that decides whether a
 * profile may be enabled is a pure function over this shape rather than a resolver interleaving
 * queries and decisions.
 */
export interface ProfileEnableSubject {
  readonly setupBundleName: string
  readonly setupBundleVersion: number
  readonly setupBundleEnabled: boolean
  readonly setupBundleArchived: boolean
  readonly workspaceName: string
  readonly workspaceVersion: number
  readonly workspaceArchived: boolean
  /** The pinned version's entries, in position order. */
  readonly entries: readonly WorkspaceEntry[]
}

/**
 * Read the bundle and workspace one profile version pins, with that version's entries.
 *
 * Both joins go through the **version** tables, because that is what the profile version pins. A
 * read that went through `setup_bundles.id` and took the latest version would answer FR-124's
 * question about an archive this profile is not pinned to.
 *
 * @returns `undefined` when the pinned rows have gone, which the foreign keys make unreachable in
 *   practice; the caller refuses rather than assuming.
 */
export const readProfileEnableSubject = async (
  writer: ProfileStoreWriter,
  version: Pick<ExecutionProfileVersion, 'setupBundleVersionId' | 'workspaceVersionId'>,
): Promise<ProfileEnableSubject | undefined> => {
  const pinned = firstRow(
    await writer
      .select({
        setupBundleName: setupBundles.name,
        setupBundleVersion: setupBundleVersions.version,
        setupBundleEnabled: setupBundles.enabled,
        setupBundleArchivedAt: setupBundles.archivedAt,
      })
      .from(setupBundleVersions)
      .innerJoin(setupBundles, eq(setupBundleVersions.setupBundleId, setupBundles.id))
      .where(eq(setupBundleVersions.id, version.setupBundleVersionId))
      .limit(1),
  )

  const workspace = firstRow(
    await writer
      .select({
        workspaceName: workspaces.name,
        workspaceVersion: workspaceVersions.version,
        workspaceArchivedAt: workspaces.archivedAt,
      })
      .from(workspaceVersions)
      .innerJoin(workspaces, eq(workspaceVersions.workspaceId, workspaces.id))
      .where(eq(workspaceVersions.id, version.workspaceVersionId))
      .limit(1),
  )

  if (pinned === undefined || workspace === undefined) {
    return undefined
  }

  const entries = await writer
    .select()
    .from(workspaceEntries)
    .where(eq(workspaceEntries.workspaceVersionId, version.workspaceVersionId))
    .orderBy(asc(workspaceEntries.position))

  return {
    setupBundleName: pinned.setupBundleName,
    setupBundleVersion: pinned.setupBundleVersion,
    setupBundleEnabled: pinned.setupBundleEnabled,
    setupBundleArchived: pinned.setupBundleArchivedAt !== null,
    workspaceName: workspace.workspaceName,
    workspaceVersion: workspace.workspaceVersion,
    workspaceArchived: workspace.workspaceArchivedAt !== null,
    entries,
  }
}

/** An integration whose mappings can start work under this profile. */
export interface ProfileIntegrationReference {
  readonly integrationId: string
  readonly name: string
  readonly enabled: boolean
}

/**
 * Everything that would break if this profile went away (FR-128).
 *
 * `archivable` is the requirement stated as a boolean: a profile referenced by an integration or by
 * a workflow that is not yet terminal must be **disabled**, never deleted. Live grants are reported
 * rather than blocking, because an admin disabling a profile needs to know how many people lose
 * access — and revoking their grants is a separate, separately audited act (FR-184).
 */
export interface ProfileReferences {
  readonly integrations: readonly ProfileIntegrationReference[]
  readonly activeWorkflowCount: number
  readonly totalWorkflowCount: number
  readonly liveGrantCount: number
  readonly archivable: boolean
}

/**
 * Read the reference sweep.
 *
 * "Non-terminal" is {@link ACTIVE_WORKFLOW_STATES} rather than a literal list, so the sweep cannot
 * drift from the state machine the next time a state is added.
 */
export const readProfileReferences = async (
  writer: ProfileStoreWriter,
  executionProfileId: string,
): Promise<ProfileReferences> => {
  const integrationRows = await writer
    .selectDistinctOn([integrations.id], {
      integrationId: integrations.id,
      name: integrations.name,
      enabled: integrations.enabled,
    })
    .from(integrationMappings)
    .innerJoin(integrations, eq(integrationMappings.integrationId, integrations.id))
    .where(eq(integrationMappings.executionProfileId, executionProfileId))
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
      .where(eq(workflows.executionProfileId, executionProfileId)),
  )

  const grants = firstRow(
    await writer
      .select({ live: sql<number>`count(*)::int` })
      .from(profileAccessGrants)
      .where(
        and(
          eq(profileAccessGrants.executionProfileId, executionProfileId),
          isNull(profileAccessGrants.revokedAt),
        ),
      ),
  )

  const activeWorkflowCount = counts?.active ?? 0

  return {
    integrations: integrationRows,
    activeWorkflowCount,
    totalWorkflowCount: counts?.total ?? 0,
    liveGrantCount: grants?.live ?? 0,
    archivable: activeWorkflowCount === 0 && integrationRows.length === 0,
  }
}
