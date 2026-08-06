import { integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

import {
  bigIntColumn,
  createdAtColumn,
  disabledByDefaultColumn,
  idColumn,
  timestampColumn,
  updatedAtColumn,
} from './columns'
import { validationOutcomeEnum } from './enums'
import { users } from './identity'

/**
 * Setup bundles — the archive that turns a bare instance into one that can build a given client's
 * repositories.
 *
 * Split into a mutable parent and immutable versions because a bundle is **immutable once
 * registered** (FR-090): replacing its contents creates a version, never mutates one. A workflow
 * that ran six months ago must still be able to say exactly which archive it unpacked, and an
 * `s3_key` that has been overwritten cannot say that.
 */

export const setupBundles = pgTable(
  'setup_bundles',
  {
    id: idColumn(),
    name: text('name').notNull(),
    description: text('description'),
    /** Registering, replacing, enabling and disabling all require admin (FR-167, FR-168). */
    enabled: disabledByDefaultColumn('enabled'),
    /** Whether this bundle's tooling can actually enforce a spend cap (FR-093). */
    spendCapsEnforceable: disabledByDefaultColumn('spend_caps_enforceable'),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id),
    /** Soft delete. A bundle referenced by a live integration or non-terminal workflow cannot be
     * archived (FR-092), and is never hard-deleted. */
    archivedAt: timestampColumn('archived_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [uniqueIndex('setup_bundles_name_key').on(table.name)],
)

/**
 * One registered archive. Immutable: nothing in this table is ever updated.
 *
 * `content_digest` is what makes the immutability checkable rather than asserted — the executor
 * verifies the downloaded archive against it during the `bundle_verify` bootstrap phase.
 */
export const setupBundleVersions = pgTable(
  'setup_bundle_versions',
  {
    id: idColumn(),
    setupBundleId: uuid('setup_bundle_id')
      .notNull()
      .references(() => setupBundles.id),
    version: integer('version').notNull(),
    s3Key: text('s3_key').notNull(),
    /** sha256 of the archive, verified at download (FR-090). */
    contentDigest: text('content_digest').notNull(),
    sizeBytes: bigIntColumn('size_bytes').notNull(),
    registeredByUserId: uuid('registered_by_user_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex('setup_bundle_versions_version_key').on(table.setupBundleId, table.version),
  ],
)

/**
 * Proving a bundle without starting an agent (FR-147, FR-148).
 *
 * Runs the bootstrap phases against the archive and records where it stopped, so a broken setup
 * script is found before it burns a paid instance mid-run.
 */
export const validationRuns = pgTable('validation_runs', {
  id: idColumn(),
  setupBundleVersionId: uuid('setup_bundle_version_id')
    .notNull()
    .references(() => setupBundleVersions.id),
  outcome: validationOutcomeEnum('outcome'),
  /** Per-phase results, keyed by `bootstrap_phase`. Null until the run finishes. */
  phaseResults: jsonb('phase_results'),
  outputS3Key: text('output_s3_key'),
  triggeredByUserId: uuid('triggered_by_user_id')
    .notNull()
    .references(() => users.id),
  startedAt: timestampColumn('started_at').notNull().defaultNow(),
  endedAt: timestampColumn('ended_at'),
})

export type SetupBundle = typeof setupBundles.$inferSelect
export type NewSetupBundle = typeof setupBundles.$inferInsert
export type SetupBundleVersion = typeof setupBundleVersions.$inferSelect
export type NewSetupBundleVersion = typeof setupBundleVersions.$inferInsert
export type ValidationRun = typeof validationRuns.$inferSelect
export type NewValidationRun = typeof validationRuns.$inferInsert
