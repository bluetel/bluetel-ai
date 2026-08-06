import { sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { check, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

import { createdAtColumn, idColumn, timestampColumn } from './columns'
import {
  correctionDeliveryOutcomeEnum,
  externalActionKindEnum,
  externalActionResultEnum,
  reviewFindingSeverityEnum,
  reviewVerdictEnum,
  supervisionCommandEnum,
  supervisionDeliveryOutcomeEnum,
  workflowStateEnum,
} from './enums'
import { users } from './identity'
import { workflowEntries, workflows } from './workflow'

/**
 * Supervision — everything a human or the platform does *to* a run while it is happening, and
 * everything the run does to the world outside itself.
 *
 * The two queues here (`corrections`, `supervision_commands`) share one discipline: the executor
 * polls, applies in `sequence` order, and acknowledges. Nothing is pushed, because a run on a
 * reclaimable instance cannot be relied on to be listening.
 */

/**
 * Extra guidance delivered to a live agent without restarting it (FR-044).
 *
 * Delivered in submission order by `sequence`. A correction that cannot be delivered fails
 * **visibly** rather than being dropped (FR-049), and one submitted against a terminal workflow is
 * `rejected` with an already-finished reason rather than accepted and lost (FR-081).
 */
export const corrections = pgTable(
  'corrections',
  {
    id: idColumn(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references((): AnyPgColumn => workflows.id),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => users.id),
    body: text('body').notNull(),
    /** What the run was doing when this was written, so a rejection is explicable afterwards. */
    workflowStateAtSubmission: workflowStateEnum('workflow_state_at_submission').notNull(),
    sequence: integer('sequence').notNull(),
    deliveryOutcome: correctionDeliveryOutcomeEnum('delivery_outcome').notNull().default('pending'),
    deliveredAt: timestampColumn('delivered_at'),
    failureReason: text('failure_reason'),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex('corrections_sequence_key').on(table.workflowId, table.sequence),
    index('corrections_pending_idx')
      .on(table.workflowId)
      .where(sql`${table.deliveryOutcome} = 'pending'`),
  ],
)

/**
 * **How the executor learns it has been paused.**
 *
 * Without this table the panel's `pause` mutation writes a state row that nothing on the instance
 * ever reads, SC-003's ten-second pause is unreachable, and the executor's `suspend()` routine is
 * fully specified and never invoked.
 *
 * A `pause` followed by a `stop` before either is collected marks the `pause` **superseded** rather
 * than applying both — the executor must not pause, acknowledge, and then discover it was also
 * asked to stop. The panel acknowledges to the user only once the executor has, so "paused" in the
 * UI means paused on the instance, not requested.
 *
 * The partial index on pending commands is the executor's poll: it runs on a bounded interval and
 * must stay cheap enough that worst-case pause latency stays inside SC-003.
 */
export const supervisionCommands = pgTable(
  'supervision_commands',
  {
    id: idColumn(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references((): AnyPgColumn => workflows.id),
    command: supervisionCommandEnum('command').notNull(),
    requestedByUserId: uuid('requested_by_user_id')
      .notNull()
      .references(() => users.id),
    sequence: integer('sequence').notNull(),
    deliveryOutcome: supervisionDeliveryOutcomeEnum('delivery_outcome')
      .notNull()
      .default('pending'),
    acknowledgedAt: timestampColumn('acknowledged_at'),
    failureReason: text('failure_reason'),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex('supervision_commands_sequence_key').on(table.workflowId, table.sequence),
    index('supervision_commands_pending_idx')
      .on(table.workflowId)
      .where(sql`${table.deliveryOutcome} = 'pending'`),
  ],
)

/**
 * One row per per-run deviation from the profile (FR-123). An attempt to override a field listed
 * in the profile version's `lockedFields` is refused, not silently ignored — which is why the
 * profile value is recorded alongside the used one.
 */
export const profileOverrides = pgTable(
  'profile_overrides',
  {
    id: idColumn(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references((): AnyPgColumn => workflows.id),
    field: text('field').notNull(),
    profileValue: text('profile_value'),
    usedValue: text('used_value').notNull(),
    setByUserId: uuid('set_by_user_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAtColumn(),
  },
  (table) => [uniqueIndex('profile_overrides_field_key').on(table.workflowId, table.field)],
)

/**
 * Append-only record of everything the run did outside itself.
 *
 * The unique index on `(workflow_id, kind, idempotency_key)` is what makes a retry **unable** to
 * produce a duplicate PR or comment (FR-077) — the second attempt loses on the index rather than
 * on a check that races. Retried under bounded backoff; on exhaustion the workflow halts with the
 * pending action recorded rather than leaving it half-applied (FR-076).
 */
export const externalActions = pgTable(
  'external_actions',
  {
    id: idColumn(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references((): AnyPgColumn => workflows.id),
    kind: externalActionKindEnum('kind').notNull(),
    targetReference: text('target_reference').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    result: externalActionResultEnum('result').notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    error: text('error'),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex('external_actions_idempotency_key').on(
      table.workflowId,
      table.kind,
      table.idempotencyKey,
    ),
  ],
)

/**
 * The one credential a run is issued, scoped to that run and to the machine surface only.
 *
 * Every machine-surface write matches `workflow_id` against the credential's target; a
 * cross-workflow attempt is denied and recorded as a security event (FR-018, FR-037). `jti` is
 * unique so a replayed token is recognisable rather than merely unexpired.
 */
export const scopedCredentials = pgTable(
  'scoped_credentials',
  {
    id: idColumn(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references((): AnyPgColumn => workflows.id),
    jti: text('jti').notNull(),
    issuedAt: timestampColumn('issued_at').notNull().defaultNow(),
    expiresAt: timestampColumn('expires_at').notNull(),
    renewalCount: integer('renewal_count').notNull().default(0),
    revokedAt: timestampColumn('revoked_at'),
  },
  (table) => [
    uniqueIndex('scoped_credentials_jti_key').on(table.jti),
    uniqueIndex('scoped_credentials_live_key')
      .on(table.workflowId)
      .where(sql`${table.revokedAt} is null`),
  ],
)

/**
 * One pass of the autonomous build-and-review loop.
 *
 * `ordinal <= 3` is a **check constraint** rather than a loop counter in application code (FR-061):
 * an autonomous run that has already burned three iterations must not be able to start a fourth
 * because a retry, a resume or a second control-plane invocation lost track of the count.
 */
export const iterations = pgTable(
  'iterations',
  {
    id: idColumn(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references((): AnyPgColumn => workflows.id),
    ordinal: integer('ordinal').notNull(),
    reviewVerdict: reviewVerdictEnum('review_verdict'),
    startedAt: timestampColumn('started_at').notNull().defaultNow(),
    endedAt: timestampColumn('ended_at'),
  },
  (table) => [
    uniqueIndex('iterations_ordinal_key').on(table.workflowId, table.ordinal),
    check('iterations_ordinal_bounds', sql`${table.ordinal} between 1 and 3`),
  ],
)

/**
 * One issue raised by a review pass, anchored to entry + file + line so a finding in a multi-repo
 * run says *which repository* it is about (FR-119).
 */
export const reviewFindings = pgTable(
  'review_findings',
  {
    id: idColumn(),
    iterationId: uuid('iteration_id')
      .notNull()
      .references(() => iterations.id),
    workflowEntryId: uuid('workflow_entry_id').references((): AnyPgColumn => workflowEntries.id),
    filePath: text('file_path'),
    line: integer('line'),
    severity: reviewFindingSeverityEnum('severity').notNull(),
    summary: text('summary').notNull(),
    /** Set when a later iteration fixed it, which is how "fixed in iteration 2" is answerable. */
    resolvedInIterationId: uuid('resolved_in_iteration_id').references(() => iterations.id),
    createdAt: createdAtColumn(),
  },
  (table) => [index('review_findings_iteration_idx').on(table.iterationId, table.severity)],
)

export type Correction = typeof corrections.$inferSelect
export type NewCorrection = typeof corrections.$inferInsert
export type SupervisionCommand = typeof supervisionCommands.$inferSelect
export type NewSupervisionCommand = typeof supervisionCommands.$inferInsert
export type ProfileOverride = typeof profileOverrides.$inferSelect
export type NewProfileOverride = typeof profileOverrides.$inferInsert
export type ExternalAction = typeof externalActions.$inferSelect
export type NewExternalAction = typeof externalActions.$inferInsert
export type ScopedCredential = typeof scopedCredentials.$inferSelect
export type NewScopedCredential = typeof scopedCredentials.$inferInsert
export type Iteration = typeof iterations.$inferSelect
export type NewIteration = typeof iterations.$inferInsert
export type ReviewFinding = typeof reviewFindings.$inferSelect
export type NewReviewFinding = typeof reviewFindings.$inferInsert
