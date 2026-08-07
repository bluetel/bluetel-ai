import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm'

import type { SetupBundle, SetupBundleVersion, SisyphusDatabase, ValidationRun } from '../../db'
import {
  executionProfiles,
  executionProfileVersions,
  integrationMappings,
  integrations,
  setupBundles,
  setupBundleVersions,
  validationRuns,
  workflows,
} from '../../db'
import { ACTIVE_WORKFLOW_STATES } from '../../enums'

import type { Page } from './user-queries'

/**
 * Data access for `setup_bundles`, `setup_bundle_versions` and `validation_runs`.
 *
 * Kept apart from the router in `bundles.ts` for the same reason `grant-store.ts` is kept apart
 * from `grants.ts`: the parts that are easy to get wrong — the version allocation, the FR-092
 * reference sweep, the "latest per bundle" reductions — belong in one named place with their own
 * test rather than inline in a resolver.
 *
 * Three rules shape this module:
 *
 * 1. **Nothing here ever updates a `setup_bundle_versions` row.** There is no `updateVersion`, and
 *    its absence is the point: archives are immutable once registered, so replacing contents
 *    inserts a version and leaves every earlier one exactly as it was (FR-090). A workflow that
 *    ran six months ago still resolves the archive it actually unpacked.
 * 2. **The version number is allocated under a row lock.** See {@link lockBundleForVersioning}.
 * 3. **Every function takes a writer rather than importing a handle**, so the insert and the audit
 *    row it belongs with commit together — the same argument as `AuditWriter` in `./audit-log`.
 */

/**
 * Anything that can run the statements this module issues — the pooled handle or a transaction
 * derived from it. Typed structurally, like `AuditWriter` and `GrantWriter`, so a caller inside
 * `db.transaction(...)` passes the transaction object without a cast.
 */
export type BundleWriter = Pick<
  SisyphusDatabase,
  'select' | 'selectDistinctOn' | 'insert' | 'update' | 'execute'
>

/** One registered archive, as the panel sees it. `s3Key` is deliberately absent — see below. */
export interface BundleVersionSummary {
  readonly id: string
  readonly version: number
  readonly contentDigest: string
  readonly sizeBytes: number
  readonly registeredByUserId: string
  readonly createdAt: Date
}

/**
 * The most recent validation of a bundle (FR-148).
 *
 * `outcome` is `null` while a run is still in flight — the row is created when the validation is
 * requested and completed by the control-plane job — and the panel renders that as "validating"
 * rather than inventing a verdict.
 */
export interface BundleValidationSummary {
  readonly id: string
  readonly setupBundleVersionId: string
  /** The bundle version this run exercised, so a stale pass against an older archive is visible. */
  readonly version: number
  readonly outcome: ValidationRun['outcome']
  readonly startedAt: Date
  readonly endedAt: Date | null
}

/**
 * One bundle as `bundles.list` returns it.
 *
 * The archive's storage key is **not** part of this shape. `bundles.list` is the one procedure a
 * non-admin may call (FR-086), and the executor gets its key from the job envelope rather than
 * from the interactive surface — so putting the key here would widen the readership of a pointer
 * into private, encrypted storage for no caller that needs it (FR-084).
 */
export interface BundleListing {
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly enabled: boolean
  readonly spendCapsEnforceable: boolean
  readonly archivedAt: Date | null
  readonly createdAt: Date
  /** `undefined` only for a bundle whose registration transaction is mid-flight. */
  readonly latestVersion: BundleVersionSummary | undefined
  /** `undefined` when the bundle has **never** been validated. Rendered as such, never faked. */
  readonly latestValidation: BundleValidationSummary | undefined
}

/** What the list query is filtered by. */
export interface ListBundlesQuery {
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

/** The bundle columns the panel reads. Deliberately not `select *`. */
const bundleColumns = {
  id: setupBundles.id,
  name: setupBundles.name,
  description: setupBundles.description,
  enabled: setupBundles.enabled,
  spendCapsEnforceable: setupBundles.spendCapsEnforceable,
  archivedAt: setupBundles.archivedAt,
  createdAt: setupBundles.createdAt,
} as const

/**
 * The most recent version of each of the named bundles, in one `distinct on`.
 *
 * `distinct on (setup_bundle_id) … order by setup_bundle_id, version desc` is one index-ordered
 * pass; the alternative — fetching every version and reducing in JavaScript — reads the whole
 * version history of every bundle on the page to keep one row from each.
 */
export const readLatestVersions = async (
  writer: BundleWriter,
  bundleIds: readonly string[],
): Promise<Map<string, BundleVersionSummary>> => {
  if (bundleIds.length === 0) {
    return new Map()
  }

  const rows = await writer
    .selectDistinctOn([setupBundleVersions.setupBundleId], {
      setupBundleId: setupBundleVersions.setupBundleId,
      id: setupBundleVersions.id,
      version: setupBundleVersions.version,
      contentDigest: setupBundleVersions.contentDigest,
      sizeBytes: setupBundleVersions.sizeBytes,
      registeredByUserId: setupBundleVersions.registeredByUserId,
      createdAt: setupBundleVersions.createdAt,
    })
    .from(setupBundleVersions)
    .where(inArray(setupBundleVersions.setupBundleId, [...bundleIds]))
    .orderBy(setupBundleVersions.setupBundleId, desc(setupBundleVersions.version))

  return new Map(rows.map(({ setupBundleId, ...version }) => [setupBundleId, version]))
}

/**
 * The most recent validation run of each of the named bundles, across all their versions (FR-148).
 *
 * Ordered by `started_at desc` rather than by version, because the question the panel asks is
 * "what happened last", and a re-validation of an older version is the later fact.
 */
export const readLatestValidations = async (
  writer: BundleWriter,
  bundleIds: readonly string[],
): Promise<Map<string, BundleValidationSummary>> => {
  if (bundleIds.length === 0) {
    return new Map()
  }

  const rows = await writer
    .selectDistinctOn([setupBundleVersions.setupBundleId], {
      setupBundleId: setupBundleVersions.setupBundleId,
      id: validationRuns.id,
      setupBundleVersionId: validationRuns.setupBundleVersionId,
      version: setupBundleVersions.version,
      outcome: validationRuns.outcome,
      startedAt: validationRuns.startedAt,
      endedAt: validationRuns.endedAt,
    })
    .from(validationRuns)
    .innerJoin(setupBundleVersions, eq(validationRuns.setupBundleVersionId, setupBundleVersions.id))
    .where(inArray(setupBundleVersions.setupBundleId, [...bundleIds]))
    .orderBy(setupBundleVersions.setupBundleId, desc(validationRuns.startedAt))

  return new Map(rows.map(({ setupBundleId, ...run }) => [setupBundleId, run]))
}

/**
 * A page of bundles with each one's latest version and latest validation.
 *
 * Keyset paginated on the primary key: every id is a UUID v7, so byte order is creation order and
 * `id desc` is newest-first without a second sort column.
 */
export const listBundles = async (
  writer: BundleWriter,
  query: ListBundlesQuery,
): Promise<Page<BundleListing>> => {
  const filters = [
    query.enabledOnly ? eq(setupBundles.enabled, true) : undefined,
    query.includeArchived ? undefined : isNull(setupBundles.archivedAt),
    query.cursor === undefined ? undefined : lt(setupBundles.id, query.cursor),
  ].filter((filter) => filter !== undefined)

  const rows = await writer
    .select(bundleColumns)
    .from(setupBundles)
    .where(filters.length === 0 ? undefined : and(...filters))
    .orderBy(desc(setupBundles.id))
    .limit(query.limit + 1)

  const page = toPage(rows, query.limit)
  const bundleIds = page.items.map((bundle) => bundle.id)
  const [versions, validations] = await Promise.all([
    readLatestVersions(writer, bundleIds),
    readLatestValidations(writer, bundleIds),
  ])

  return {
    items: page.items.map((bundle) => ({
      ...bundle,
      latestVersion: versions.get(bundle.id),
      latestValidation: validations.get(bundle.id),
    })),
    nextCursor: page.nextCursor,
  }
}

/** One bundle by id, or `undefined`. */
export const findBundle = async (
  writer: BundleWriter,
  setupBundleId: string,
): Promise<SetupBundle | undefined> =>
  firstRow(
    await writer.select().from(setupBundles).where(eq(setupBundles.id, setupBundleId)).limit(1),
  )

/**
 * One bundle by name, or `undefined`.
 *
 * Used to turn the unique-index violation a duplicate name would otherwise produce into a refusal
 * that names the problem. `name` is plain `text`, so the comparison is case-sensitive and matches
 * the index exactly — a check that lower-cased here would refuse names the database would accept.
 */
export const findBundleByName = async (
  writer: BundleWriter,
  name: string,
): Promise<SetupBundle | undefined> =>
  firstRow(await writer.select().from(setupBundles).where(eq(setupBundles.name, name)).limit(1))

/** One bundle version by id, or `undefined`. */
export const findBundleVersion = async (
  writer: BundleWriter,
  setupBundleVersionId: string,
): Promise<SetupBundleVersion | undefined> =>
  firstRow(
    await writer
      .select()
      .from(setupBundleVersions)
      .where(eq(setupBundleVersions.id, setupBundleVersionId))
      .limit(1),
  )

/**
 * Lock the bundle row and report the highest version number registered against it.
 *
 * **Must be called inside a transaction.** Two admins replacing the same bundle's archive at the
 * same moment would otherwise both read `max(version) = 3` and both try to insert version 4; the
 * unique index on `(setup_bundle_id, version)` would turn the loser into a duplicate-key error
 * rather than into version 5. `for update` on the parent row makes the loser wait and then re-read,
 * so the second replacement is an ordinary operation and not a retry.
 *
 * The lock is taken on `setup_bundles`, not on the version rows: there is no row to lock for the
 * version that does not exist yet, and the parent is the one row both callers are certain to
 * contend on.
 *
 * @returns `undefined` when there is no such bundle, otherwise the current highest version — `0`
 *   for a bundle with no versions at all.
 */
export const lockBundleForVersioning = async (
  writer: BundleWriter,
  setupBundleId: string,
): Promise<{ readonly bundle: SetupBundle; readonly highestVersion: number } | undefined> => {
  const bundle = firstRow(
    await writer
      .select()
      .from(setupBundles)
      .where(eq(setupBundles.id, setupBundleId))
      .limit(1)
      .for('update'),
  )

  if (bundle === undefined) {
    return undefined
  }

  const highest = firstRow(
    await writer
      .select({ highest: sql<number>`coalesce(max(${setupBundleVersions.version}), 0)::int` })
      .from(setupBundleVersions)
      .where(eq(setupBundleVersions.setupBundleId, setupBundleId)),
  )

  return { bundle, highestVersion: highest?.highest ?? 0 }
}

export interface InsertBundleInput {
  readonly name: string
  readonly description: string | undefined
  readonly spendCapsEnforceable: boolean
  readonly createdByUserId: string
}

/** Insert the parent row. Disabled by default — enabling is a separate, audited act (FR-167). */
export const insertBundle = async (
  writer: BundleWriter,
  input: InsertBundleInput,
): Promise<SetupBundle> => {
  const row = firstRow(
    await writer
      .insert(setupBundles)
      .values({
        name: input.name,
        description: input.description ?? null,
        spendCapsEnforceable: input.spendCapsEnforceable,
        createdByUserId: input.createdByUserId,
      })
      .returning(),
  )

  if (row === undefined) {
    throw new Error('Inserting a setup bundle returned no row.')
  }
  return row
}

export interface InsertBundleVersionInput {
  readonly setupBundleId: string
  readonly version: number
  readonly s3Key: string
  readonly contentDigest: string
  readonly sizeBytes: number
  readonly registeredByUserId: string
}

/**
 * Insert one immutable version row.
 *
 * There is no upsert and no `onConflictDoUpdate` here on purpose. A conflict on
 * `(setup_bundle_id, version)` means two callers raced past the lock above, and the correct
 * outcome is a loud failure rather than one archive silently replacing another (FR-090).
 */
export const insertBundleVersion = async (
  writer: BundleWriter,
  input: InsertBundleVersionInput,
): Promise<SetupBundleVersion> => {
  const row = firstRow(
    await writer
      .insert(setupBundleVersions)
      .values({ ...input })
      .returning(),
  )

  if (row === undefined) {
    throw new Error('Inserting a setup bundle version returned no row.')
  }
  return row
}

export interface UpdateBundleFields {
  readonly name?: string
  readonly description?: string | null
  readonly spendCapsEnforceable?: boolean
  readonly enabled?: boolean
  /**
   * The soft delete. A bundle referenced by an integration or a non-terminal workflow must never
   * reach this field — see {@link readBundleReferences}; disabling is what FR-092 offers instead.
   */
  readonly archivedAt?: Date | null
}

/** Update the mutable parent row. Cannot reach a version row — the type has no field for one. */
export const updateBundle = async (
  writer: BundleWriter,
  setupBundleId: string,
  fields: UpdateBundleFields,
): Promise<SetupBundle | undefined> =>
  firstRow(
    await writer
      .update(setupBundles)
      .set(fields)
      .where(eq(setupBundles.id, setupBundleId))
      .returning(),
  )

/** An execution profile that pins one of this bundle's versions. */
export interface ProfileReference {
  readonly executionProfileId: string
  readonly name: string
  readonly enabled: boolean
}

/** An integration whose mappings can start work under one of those profiles. */
export interface IntegrationReference {
  readonly integrationId: string
  readonly name: string
  readonly enabled: boolean
}

/**
 * Everything that would break if this bundle went away (FR-092, FR-086).
 *
 * `archivable` is the requirement stated as a boolean: a bundle referenced by an integration or by
 * a workflow that is not yet in a terminal state must be **disabled**, never deleted. Execution
 * profiles alone do not block archiving — an archived bundle whose profile is disabled is a
 * legitimate end state — but they are reported because an admin about to disable a bundle needs to
 * know which launch presets stop working.
 */
export interface BundleReferences {
  readonly executionProfiles: readonly ProfileReference[]
  readonly integrations: readonly IntegrationReference[]
  /** Workflows still holding, or still able to hold, compute against this bundle. */
  readonly activeWorkflowCount: number
  readonly totalWorkflowCount: number
  readonly archivable: boolean
}

/**
 * Read the reference sweep.
 *
 * "Non-terminal" is {@link ACTIVE_WORKFLOW_STATES} rather than a literal list: it is exactly
 * `WORKFLOW_STATES` minus `TERMINAL_WORKFLOW_STATES`, and restating it here would let the two
 * drift the next time a state is added.
 */
export const readBundleReferences = async (
  writer: BundleWriter,
  setupBundleId: string,
): Promise<BundleReferences> => {
  const profileRows = await writer
    .selectDistinctOn([executionProfiles.id], {
      executionProfileId: executionProfiles.id,
      name: executionProfiles.name,
      enabled: executionProfiles.enabled,
    })
    .from(executionProfileVersions)
    .innerJoin(
      setupBundleVersions,
      eq(executionProfileVersions.setupBundleVersionId, setupBundleVersions.id),
    )
    .innerJoin(
      executionProfiles,
      eq(executionProfileVersions.executionProfileId, executionProfiles.id),
    )
    .where(eq(setupBundleVersions.setupBundleId, setupBundleId))
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
      .innerJoin(setupBundleVersions, eq(workflows.setupBundleVersionId, setupBundleVersions.id))
      .where(eq(setupBundleVersions.setupBundleId, setupBundleId)),
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

/**
 * Open a validation run against one bundle version (FR-147).
 *
 * The row is created here with no `outcome` and no `ended_at`: this records that a validation was
 * *asked for*, by whom and when. The control-plane job that provisions the instance and runs the
 * phases fills the rest in. Writing a verdict at request time would be inventing one.
 */
export const insertValidationRun = async (
  writer: BundleWriter,
  input: { readonly setupBundleVersionId: string; readonly triggeredByUserId: string },
): Promise<ValidationRun> => {
  const row = firstRow(
    await writer
      .insert(validationRuns)
      .values({ ...input })
      .returning(),
  )

  if (row === undefined) {
    throw new Error('Inserting a validation run returned no row.')
  }
  return row
}

/** One validation run as the panel lists it, with the version it exercised. */
export interface ValidationRunListing {
  readonly id: string
  readonly setupBundleVersionId: string
  readonly version: number
  readonly outcome: ValidationRun['outcome']
  readonly phaseResults: unknown
  readonly triggeredByUserId: string
  readonly startedAt: Date
  readonly endedAt: Date | null
}

/** Every validation run recorded against any version of one bundle, newest first (FR-148). */
export const listValidationRuns = async (
  writer: BundleWriter,
  setupBundleId: string,
  limit: number,
): Promise<readonly ValidationRunListing[]> =>
  writer
    .select({
      id: validationRuns.id,
      setupBundleVersionId: validationRuns.setupBundleVersionId,
      version: setupBundleVersions.version,
      outcome: validationRuns.outcome,
      phaseResults: validationRuns.phaseResults,
      triggeredByUserId: validationRuns.triggeredByUserId,
      startedAt: validationRuns.startedAt,
      endedAt: validationRuns.endedAt,
    })
    .from(validationRuns)
    .innerJoin(setupBundleVersions, eq(validationRuns.setupBundleVersionId, setupBundleVersions.id))
    .where(eq(setupBundleVersions.setupBundleId, setupBundleId))
    .orderBy(desc(validationRuns.startedAt))
    .limit(limit)
