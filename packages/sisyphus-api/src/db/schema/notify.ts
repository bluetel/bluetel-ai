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

import { createdAtColumn, idColumn, updatedAtColumn } from './columns'
import { notificationChannelEnum, notificationEventEnum, notificationOutcomeEnum } from './enums'
import { users } from './identity'
import { workflows } from './workflow'

/**
 * Notification and audit — telling people what happened, and keeping the record of who changed
 * what.
 *
 * The governing rule for this whole file: **a notification is written outside the workflow's state
 * transition.** A delivery failure never alters workflow state (FR-141, SC-042). A run that
 * succeeded and could not be announced is a successful run with a failed notification, not a
 * failed run.
 */

/**
 * Append-only record of every delivery attempt (FR-141).
 *
 * `workflowId` is nullable because FR-139's integration-tick summary is one message about many
 * workflows: recording it against an arbitrary one of them would be a lie, and not recording it
 * would leave the one message a user actually received absent from the audit.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: idColumn(),
    workflowId: uuid('workflow_id').references((): AnyPgColumn => workflows.id),
    recipientUserId: uuid('recipient_user_id')
      .notNull()
      .references(() => users.id),
    event: notificationEventEnum('event').notNull(),
    channel: notificationChannelEnum('channel').notNull().default('slack_dm'),
    outcome: notificationOutcomeEnum('outcome').notNull(),
    /** How many transitions this message coalesced, for the FR-139 rate limit. */
    coalescedCount: integer('coalesced_count').notNull().default(1),
    error: text('error'),
    createdAt: createdAtColumn(),
  },
  (table) => [
    index('notifications_recipient_idx').on(table.recipientUserId, table.createdAt.desc()),
    index('notifications_workflow_idx').on(table.workflowId, table.createdAt.desc()),
  ],
)

/**
 * Per-event opt-out for a workflow's owner or watcher (FR-138).
 *
 * **Absence of a row means enabled.** A user who has never opened their preferences still gets
 * notified — the default is not silence. This is why the column below defaults to `true` and is
 * `notNull`: a row exists only to record a decision, and the only decision worth recording is
 * usually `false`. Reads must therefore be written as `coalesce(preference.enabled, true)` rather
 * than as an inner join, which would silently drop every user who has no rows at all.
 *
 * `event` is constrained to the same closed set `notifications.event` records, so a preference
 * cannot reference an event that will never fire.
 */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    id: idColumn(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    event: notificationEventEnum('event').notNull(),
    /** Defaults to enabled, matching the meaning of no row at all (FR-138). */
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [uniqueIndex('notification_preferences_event_key').on(table.userId, table.event)],
)

/**
 * Lets a user follow a workflow they do **not** own (FR-138).
 *
 * Watching is subject to the same scoping as reading: a user may only watch a workflow they are
 * already permitted to see, so this table cannot be used to learn that an out-of-scope workflow
 * exists (FR-190). A watcher receives the events the owner would, filtered by their own
 * preferences. Removing a grant removes the watch rather than silently continuing to deliver
 * (FR-188).
 */
export const workflowWatchers = pgTable(
  'workflow_watchers',
  {
    id: idColumn(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references((): AnyPgColumn => workflows.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAtColumn(),
  },
  (table) => [uniqueIndex('workflow_watchers_user_key').on(table.workflowId, table.userId)],
)

/**
 * Append-only audit of every configuration change (FR-178): bundle registration, replacement,
 * enable and disable, plus grant changes.
 *
 * `actorUserId` is null for the deploy-time bootstrap reconcile — the same `system` actor that
 * appears in `role_changes` (FR-174). `entityVersion` records *which version* of a versioned
 * entity the action produced, so an audit row for a profile edit points at content that still
 * exists.
 */
export const configurationAudit = pgTable(
  'configuration_audit',
  {
    id: idColumn(),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    entityVersion: integer('entity_version'),
    action: text('action').notNull(),
    detail: jsonb('detail'),
    createdAt: createdAtColumn(),
  },
  (table) => [
    index('configuration_audit_entity_idx').on(
      table.entityType,
      table.entityId,
      table.createdAt.desc(),
    ),
  ],
)

export type Notification = typeof notifications.$inferSelect
export type NewNotification = typeof notifications.$inferInsert
export type NotificationPreference = typeof notificationPreferences.$inferSelect
export type NewNotificationPreference = typeof notificationPreferences.$inferInsert
export type WorkflowWatcher = typeof workflowWatchers.$inferSelect
export type NewWorkflowWatcher = typeof workflowWatchers.$inferInsert
export type ConfigurationAuditEntry = typeof configurationAudit.$inferSelect
export type NewConfigurationAuditEntry = typeof configurationAudit.$inferInsert
