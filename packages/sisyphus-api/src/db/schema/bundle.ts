import { sql } from 'drizzle-orm'
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

/**
 * **The credential a validation run authenticates with (T200, FR-147, 003/FR-052).**
 *
 * Until this table existed a validation run could not reach the machine surface at all. The control
 * plane minted it a token with a `validation:<id>` subject, the verifier refused that subject
 * outright, and `apps/sisyphus-executor` halted on a named error rather than running: there was no
 * row for the token to name, because `scoped_credentials.workflow_id` is `not null` and a validation
 * has no workflow. FR-147's per-phase reporting was therefore unreachable by construction.
 *
 * ## Why a second table rather than a nullable `scoped_credentials.workflow_id`
 *
 * The alternative was to make that column nullable and let a validation row sit in the same table.
 * It is rejected here for the reason `jobs/validate-bundle.ts` already gives for *not* recording a
 * validation as a workflow: loosening a `not null` column so a handful of rows can omit it makes
 * every other row in the table one `null` away from being unattributable, and pushes the check into
 * every consumer. That cost is concrete rather than stylistic —
 * `server/machine/credential-verification.ts` compares `stored.workflowId` against the subject and
 * `MachineCredential.workflowId` is a `string` that `machineProcedure` puts on `ctx.workflowId`, so
 * a nullable column would have widened the type every workflow-scoped write in the platform is
 * built on, to express a state none of them can ever be in.
 *
 * It also keeps `scoped_credentials_live_key` **untouched**. That index is a partial unique index on
 * `(workflow_id) WHERE revoked_at is null` — at most one live credential per run, which is what
 * makes a re-mint supersede rather than duplicate and what makes a replayed token from a previous
 * instance recognisably dead. Reworking a live safety index to accommodate rows it was not written
 * for is a change whose failure mode is silent; not touching it is the strongest available proof it
 * was not weakened.
 *
 * ## What it does keep from `scoped_credentials`, and why
 *
 * The same shape, deliberately: a unique `jti` so a replayed token resolves to a row that is
 * *recognisably* superseded rather than merely unexpired; a short `expires_at` that the verifier
 * reads instead of the token's much longer ceiling; and a partial unique index on the run, so a
 * second mint for the same validation revokes the incumbent rather than creating a second live
 * credential for one instance.
 *
 * `renewal_count` exists and is expected to stay zero. A validation is bounded by
 * `VALIDATION_BUDGET_MS` (45 minutes) and its credential window is 15, so a long `setup.sh` will
 * legitimately renew; the column is here so that when it does, the count says so.
 *
 * ## What it deliberately does not have (003/FR-052)
 *
 * No agent credential, no lease, no reference to `credential_groups` — nothing that touches the
 * pool. 003/FR-052 requires that proving a bundle consumes no pool capacity, and the way that is
 * held is that there is no column here through which a validation could take a seat. A validation
 * instance never reaches bootstrap phase `credential_install` and never calls
 * `machine.fetchAgentCredential`, because `validationProcedure` resolves no workflow and every
 * procedure that touches the pool is a `machineProcedure` scoped to one.
 */
export const validationCredentials = pgTable(
  'validation_credentials',
  {
    id: idColumn(),
    validationRunId: uuid('validation_run_id')
      .notNull()
      .references(() => validationRuns.id),
    jti: text('jti').notNull(),
    issuedAt: timestampColumn('issued_at').notNull().defaultNow(),
    expiresAt: timestampColumn('expires_at').notNull(),
    renewalCount: integer('renewal_count').notNull().default(0),
    revokedAt: timestampColumn('revoked_at'),
  },
  (table) => [
    uniqueIndex('validation_credentials_jti_key').on(table.jti),
    uniqueIndex('validation_credentials_live_key')
      .on(table.validationRunId)
      .where(sql`${table.revokedAt} is null`),
  ],
)

export type SetupBundle = typeof setupBundles.$inferSelect
export type NewSetupBundle = typeof setupBundles.$inferInsert
export type SetupBundleVersion = typeof setupBundleVersions.$inferSelect
export type NewSetupBundleVersion = typeof setupBundleVersions.$inferInsert
export type ValidationRun = typeof validationRuns.$inferSelect
export type NewValidationRun = typeof validationRuns.$inferInsert
export type ValidationCredential = typeof validationCredentials.$inferSelect
export type NewValidationCredential = typeof validationCredentials.$inferInsert
