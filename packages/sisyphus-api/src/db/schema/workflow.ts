import { sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { setupBundleVersions } from './bundle'
import {
  createdAtColumn,
  disabledByDefaultColumn,
  idColumn,
  moneyColumn,
  timestampColumn,
  updatedAtColumn,
} from './columns'
import {
  actorTypeEnum,
  bootstrapPhaseEnum,
  bootstrapPhaseOutcomeEnum,
  claudeModelEnum,
  entryResultEnum,
  purchaseModeEnum,
  terminalOutcomeEnum,
  workflowEventEnum,
  workflowStateEnum,
  workflowTypeEnum,
} from './enums'
import { users } from './identity'
import { integrationMappings, integrations } from './integration'
import {
  executionProfiles,
  executionProfileVersions,
  workspaceEntries,
  workspaceVersions,
} from './profile'
import { sessionSnapshots } from './run-record'

/**
 * The workflow aggregate — a run, its per-repository entries, its timeline, its compute and its
 * bootstrap.
 *
 * Two of the indexes in this file are load-bearing correctness constraints rather than
 * performance tuning; see `computeLeases`.
 */

/**
 * One run.
 *
 * The job-spec columns (`model`, `instanceType`, `purchaseMode`, `turnCap`, `spendCap`) are
 * **write-once**: continuing with changed configuration creates a *successor* workflow inheriting
 * the snapshot, never an edit (FR-149, FR-150, FR-151). Consumption is summable across a chain via
 * `predecessorWorkflowId` (FR-152).
 */
export const workflows = pgTable(
  'workflows',
  {
    id: idColumn(),
    type: workflowTypeEnum('type').notNull(),
    state: workflowStateEnum('state').notNull(),
    /** Exactly one in force at a time when terminal (FR-064). */
    terminalOutcome: terminalOutcomeEnum('terminal_outcome'),
    outcomeReason: text('outcome_reason'),

    /** Null when the run was started by an integration rather than a person. */
    initiatedByUserId: uuid('initiated_by_user_id').references(() => users.id),
    originatingIntegrationId: uuid('originating_integration_id').references(
      (): AnyPgColumn => integrations.id,
    ),
    /** Why it got these settings — which mapping matched (FR-131). */
    originatingMappingId: uuid('originating_mapping_id').references(
      (): AnyPgColumn => integrationMappings.id,
    ),
    /** Not null: exactly one human is accountable for every run (FR-132). */
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id),

    /** Null means the run was ad hoc rather than launched from a profile (FR-126). */
    executionProfileId: uuid('execution_profile_id').references(
      (): AnyPgColumn => executionProfiles.id,
    ),
    /** Reconstructs the exact launch configuration for the retention period (FR-065, FR-126). */
    executionProfileVersionId: uuid('execution_profile_version_id').references(
      (): AnyPgColumn => executionProfileVersions.id,
    ),
    setupBundleVersionId: uuid('setup_bundle_version_id')
      .notNull()
      .references((): AnyPgColumn => setupBundleVersions.id),
    /** The entry set as it was at launch, not as it is now (FR-125). */
    workspaceVersionId: uuid('workspace_version_id')
      .notNull()
      .references((): AnyPgColumn => workspaceVersions.id),

    ticketReference: text('ticket_reference'),
    /** Shared across every entry of a multi-repo run (FR-116). */
    resultBranchName: text('result_branch_name'),
    /** The prompt **as sent**; null only for a validation run (FR-147, FR-162). */
    assembledPrompt: text('assembled_prompt'),
    /** Oldest-first comment truncation occurred while assembling the prompt (FR-163). */
    promptTruncated: disabledByDefaultColumn('prompt_truncated'),

    model: claudeModelEnum('model').notNull(),
    instanceType: text('instance_type').notNull(),
    purchaseMode: purchaseModeEnum('purchase_mode').notNull(),
    turnCap: integer('turn_cap'),
    spendCap: moneyColumn('spend_cap'),
    turnsUsed: integer('turns_used').notNull().default(0),
    spendUsed: moneyColumn('spend_used').notNull().default('0'),
    /** Compute charged to this run, for total attribution alongside inference (FR-041). */
    computeCostBasis: moneyColumn('compute_cost_basis'),

    /** Successor chain (FR-150, FR-152). */
    predecessorWorkflowId: uuid('predecessor_workflow_id').references(
      (): AnyPgColumn => workflows.id,
    ),
    /** Platform-assigned before the agent starts, so a snapshot can be resumed (FR-052, R2). */
    sessionId: uuid('session_id').notNull(),
    currentSnapshotId: uuid('current_snapshot_id').references(
      (): AnyPgColumn => sessionSnapshots.id,
    ),
    /** Written for the reviewer of the resulting change (FR-153). */
    reviewerSummary: text('reviewer_summary'),
    /** The owner was deactivated and someone must take this run over (FR-176). */
    needsReassignment: disabledByDefaultColumn('needs_reassignment'),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    /** The panel's primary read: a scoped list, newest first (FR-012, FR-013). */
    index('workflows_profile_state_idx').on(
      table.executionProfileId,
      table.state,
      table.createdAt.desc(),
    ),
    /** The needs-attention view (FR-135). */
    index('workflows_owner_state_idx').on(table.ownerUserId, table.state),
    index('workflows_integration_idx').on(table.originatingIntegrationId, table.createdAt.desc()),
    /** Successor chain traversal (FR-152). */
    index('workflows_predecessor_idx').on(table.predecessorWorkflowId),
  ],
)

/**
 * Per workspace entry, per run — the multi-repo unit (FR-114, FR-115, FR-118).
 *
 * `resolvedCommit` is recorded at checkout so the run is reproducible, and staleness is evaluated
 * **per entry** rather than for the workflow as a whole (FR-079, FR-114). If any entry is `failed`
 * while another is `landed`, the workflow's terminal outcome states the partial state and must not
 * be plain success (FR-118).
 */
export const workflowEntries = pgTable(
  'workflow_entries',
  {
    id: idColumn(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references((): AnyPgColumn => workflows.id),
    /** The version-pinned entry this was resolved from. */
    workspaceEntryId: uuid('workspace_entry_id')
      .notNull()
      .references((): AnyPgColumn => workspaceEntries.id),
    repositoryUrl: text('repository_url').notNull(),
    baseBranch: text('base_branch').notNull(),
    subdirectory: text('subdirectory').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    resolvedCommit: text('resolved_commit'),
    wasChanged: disabledByDefaultColumn('was_changed'),
    /** At most one PR per entry (FR-115). */
    pullRequestUrl: text('pull_request_url'),
    entryResult: entryResultEnum('entry_result'),
    stalenessNote: text('staleness_note'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    /**
     * The FR-120 advisory-lock probe, **not** a constraint: two non-terminal workflows may not hold
     * the same `(repository_url, base_branch)`, but that predicate is over `workflows.state`, which
     * cannot be expressed in an index on this table. The lock is the sole mechanism; this index
     * only makes finding the current holders cheap.
     */
    index('workflow_entries_repository_branch_idx').on(table.repositoryUrl, table.baseBranch),
    uniqueIndex('workflow_entries_workflow_entry_key').on(table.workflowId, table.workspaceEntryId),
  ],
)

/**
 * The append-only timeline the panel renders. Every state transition is timestamped and attributed
 * to the actor that caused it (FR-064). Never mutated, so there is no `updated_at`.
 */
export const workflowEvents = pgTable(
  'workflow_events',
  {
    id: idColumn(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references((): AnyPgColumn => workflows.id),
    event: workflowEventEnum('event').notNull(),
    actorType: actorTypeEnum('actor_type').notNull(),
    /** Set only when `actorType` is `user`. */
    actorUserId: uuid('actor_user_id').references(() => users.id),
    detail: jsonb('detail'),
    createdAt: createdAtColumn(),
  },
  (table) => [index('workflow_events_workflow_idx').on(table.workflowId, table.createdAt)],
)

/**
 * One instance held for one run, tagged with the workflow id for cost attribution (FR-041).
 *
 * **The two indexes below are the correctness mechanism, not tuning.**
 *
 * - `compute_leases_live_key` — a partial unique index on `(workflow_id) WHERE released_at IS
 *   NULL`. Starting the same workflow twice concurrently provisions at most one instance (FR-078)
 *   because the second admission loses *on the index* rather than on application timing. The loser
 *   returns the existing workflow, not an error: a double-clicked launch button is a duplicate
 *   request, not a failure.
 * - `compute_leases_unreleased_idx` — a partial index on `(released_at) WHERE released_at IS
 *   NULL`. The FR-040 admission ceiling is counted inside the admitting transaction against *live
 *   leases*, because a lease is what actually costs money — a workflow row does not. This index is
 *   what keeps that count from degrading into a scan of every lease ever taken.
 *
 * The reconciliation sweep reads this table in both directions: a lease with no live workflow is
 * released, and a workflow whose lease vanished or whose heartbeat lapsed moves to
 * `parked_resumable` or `failed` with the reason recorded (FR-039, FR-048).
 */
export const computeLeases = pgTable(
  'compute_leases',
  {
    id: idColumn(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references((): AnyPgColumn => workflows.id),
    /** Null between requesting capacity and being given an instance. */
    providerInstanceId: text('provider_instance_id'),
    instanceType: text('instance_type').notNull(),
    purchaseMode: purchaseModeEnum('purchase_mode').notNull(),
    requestedAt: timestampColumn('requested_at').notNull().defaultNow(),
    readyAt: timestampColumn('ready_at'),
    releasedAt: timestampColumn('released_at'),
    lastHeartbeatAt: timestampColumn('last_heartbeat_at'),
    releaseReason: text('release_reason'),
  },
  (table) => [
    uniqueIndex('compute_leases_live_key')
      .on(table.workflowId)
      .where(sql`${table.releasedAt} is null`),
    index('compute_leases_unreleased_idx')
      .on(table.releasedAt)
      .where(sql`${table.releasedAt} is null`),
  ],
)

/**
 * The bootstrap broken into attributable steps (FR-145, FR-146, SC-037).
 *
 * Each phase has its own timeout; exceeding it fails the workflow **naming the phase**, which is
 * what turns an opaque multi-minute "provisioning" state into one a human can act on.
 */
export const bootstrapPhases = pgTable(
  'bootstrap_phases',
  {
    id: idColumn(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references((): AnyPgColumn => workflows.id),
    phase: bootstrapPhaseEnum('phase').notNull(),
    /** Set for per-entry phases such as `entry_checkout`. */
    entryId: uuid('entry_id').references((): AnyPgColumn => workflowEntries.id),
    sequence: integer('sequence').notNull(),
    startedAt: timestampColumn('started_at').notNull().defaultNow(),
    endedAt: timestampColumn('ended_at'),
    outcome: bootstrapPhaseOutcomeEnum('outcome'),
    detail: text('detail'),
  },
  (table) => [uniqueIndex('bootstrap_phases_sequence_key').on(table.workflowId, table.sequence)],
)

export type Workflow = typeof workflows.$inferSelect
export type NewWorkflow = typeof workflows.$inferInsert
export type WorkflowEntry = typeof workflowEntries.$inferSelect
export type NewWorkflowEntry = typeof workflowEntries.$inferInsert
export type WorkflowEvent = typeof workflowEvents.$inferSelect
export type NewWorkflowEvent = typeof workflowEvents.$inferInsert
export type ComputeLease = typeof computeLeases.$inferSelect
export type NewComputeLease = typeof computeLeases.$inferInsert
export type BootstrapPhase = typeof bootstrapPhases.$inferSelect
export type NewBootstrapPhase = typeof bootstrapPhases.$inferInsert
