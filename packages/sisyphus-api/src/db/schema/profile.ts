import { sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { boolean, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

import { DEFAULT_PURCHASE_MODE } from '../../enums'

import { setupBundleVersions } from './bundle'
import {
  createdAtColumn,
  disabledByDefaultColumn,
  idColumn,
  moneyColumn,
  timestampColumn,
  updatedAtColumn,
} from './columns'
import { claudeModelEnum, purchaseModeEnum, workflowTypeEnum } from './enums'
import { users } from './identity'

/**
 * Workspaces and execution profiles — the configuration a run is launched from.
 *
 * Both are split into a mutable parent and immutable versions, and in both cases **everything a
 * run depends on hangs off the version, never the parent**. FR-125 requires an edit to create a
 * new version leaving in-flight runs untouched; a single mutable row carrying a `version` integer
 * cannot do that, because the number would point at content that no longer exists and FR-065's
 * "record what it ran with" would be recording a lie.
 */

/** A set of repositories that are checked out together. Identity and pointer state only. */
export const workspaces = pgTable(
  'workspaces',
  {
    id: idColumn(),
    name: text('name').notNull(),
    description: text('description'),
    enabled: disabledByDefaultColumn('enabled'),
    /** Advanced by an edit, which creates a new version (FR-125). */
    currentVersionId: uuid('current_version_id').references(
      (): AnyPgColumn => workspaceVersions.id,
    ),
    /** Soft delete; in-flight and historical workflows reference this row (FR-128). */
    archivedAt: timestampColumn('archived_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [uniqueIndex('workspaces_name_key').on(table.name)],
)

/**
 * One immutable snapshot of a workspace's entry set.
 *
 * A running workflow pins `workspace_version_id`, which is what makes the spec's "workspace grows
 * an entry mid-run" edge case harmless: the run still resolves the version it started with
 * (FR-125, FR-149).
 */
export const workspaceVersions = pgTable(
  'workspace_versions',
  {
    id: idColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references((): AnyPgColumn => workspaces.id),
    version: integer('version').notNull(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAtColumn(),
  },
  (table) => [uniqueIndex('workspace_versions_version_key').on(table.workspaceId, table.version)],
)

/**
 * One repository in a workspace version. **Hangs off the version, not the workspace.**
 *
 * The two partial/unique indexes below are FR-110 and FR-111 expressed at the database: exactly
 * one primary entry per version, and one entry per subdirectory per version. Both are scoped to
 * the version rather than the workspace, because a new version legitimately repeats the
 * subdirectories and the primary flag of the one before it.
 */
export const workspaceEntries = pgTable(
  'workspace_entries',
  {
    id: idColumn(),
    workspaceVersionId: uuid('workspace_version_id')
      .notNull()
      .references((): AnyPgColumn => workspaceVersions.id),
    repositoryUrl: text('repository_url').notNull(),
    baseBranch: text('base_branch').notNull(),
    /** Validated to resolve inside the pinned workspace root, rejected at validation time
     * otherwise (FR-111). */
    subdirectory: text('subdirectory').notNull(),
    /** The entry skills and the result branch are resolved from (FR-110). */
    isPrimary: boolean('is_primary').notNull().default(false),
    position: integer('position').notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex('workspace_entries_subdirectory_key').on(
      table.workspaceVersionId,
      table.subdirectory,
    ),
    uniqueIndex('workspace_entries_primary_key')
      .on(table.workspaceVersionId)
      .where(sql`${table.isPrimary}`),
    uniqueIndex('workspace_entries_position_key').on(table.workspaceVersionId, table.position),
  ],
)

/**
 * The launch preset **and the unit of access control** (FR-121, FR-179).
 *
 * Identity and pointer state only — every launch value lives on `execution_profile_versions`.
 * Cannot be enabled until validation confirms the setup bundle is enabled and every workspace
 * entry's repository and branch are reachable (FR-124). Never hard-deleted while referenced;
 * disable instead (FR-128).
 */
export const executionProfiles = pgTable(
  'execution_profiles',
  {
    id: idColumn(),
    name: text('name').notNull(),
    description: text('description'),
    currentVersionId: uuid('current_version_id').references(
      (): AnyPgColumn => executionProfileVersions.id,
    ),
    enabled: disabledByDefaultColumn('enabled'),
    archivedAt: timestampColumn('archived_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [uniqueIndex('execution_profiles_name_key').on(table.name)],
)

/**
 * A snapshot of **every** launch value the profile carried at this version. Immutable.
 *
 * The version pins the *bundle version and workspace version*, not just their ids: a profile that
 * validated against one bundle version has not been silently re-pointed at another.
 * `workflows.execution_profile_version_id` reconstructs the exact launch configuration for the
 * whole retention period (FR-065, FR-125, FR-126, SC-021).
 */
export const executionProfileVersions = pgTable(
  'execution_profile_versions',
  {
    id: idColumn(),
    executionProfileId: uuid('execution_profile_id')
      .notNull()
      .references((): AnyPgColumn => executionProfiles.id),
    version: integer('version').notNull(),
    workspaceVersionId: uuid('workspace_version_id')
      .notNull()
      .references((): AnyPgColumn => workspaceVersions.id),
    setupBundleVersionId: uuid('setup_bundle_version_id')
      .notNull()
      .references(() => setupBundleVersions.id),
    model: claudeModelEnum('model').notNull(),
    instanceType: text('instance_type').notNull(),
    purchaseMode: purchaseModeEnum('purchase_mode').notNull().default(DEFAULT_PURCHASE_MODE),
    turnCap: integer('turn_cap'),
    spendCap: moneyColumn('spend_cap'),
    defaultWorkflowType: workflowTypeEnum('default_workflow_type').notNull(),
    /** The profile's layer of the assembled prompt, above the integration's `prompt_intro`. */
    promptPreamble: text('prompt_preamble'),
    /** Fields a per-run override may not touch; an attempt is refused, not ignored (FR-123). */
    lockedFields: text('locked_fields').array().notNull().default([]),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex('execution_profile_versions_version_key').on(
      table.executionProfileId,
      table.version,
    ),
  ],
)

export type Workspace = typeof workspaces.$inferSelect
export type NewWorkspace = typeof workspaces.$inferInsert
export type WorkspaceVersion = typeof workspaceVersions.$inferSelect
export type NewWorkspaceVersion = typeof workspaceVersions.$inferInsert
export type WorkspaceEntry = typeof workspaceEntries.$inferSelect
export type NewWorkspaceEntry = typeof workspaceEntries.$inferInsert
export type ExecutionProfile = typeof executionProfiles.$inferSelect
export type NewExecutionProfile = typeof executionProfiles.$inferInsert
export type ExecutionProfileVersion = typeof executionProfileVersions.$inferSelect
export type NewExecutionProfileVersion = typeof executionProfileVersions.$inferInsert
