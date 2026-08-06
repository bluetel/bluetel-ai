import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

import {
  createdAtColumn,
  disabledByDefaultColumn,
  idColumn,
  timestampColumn,
  updatedAtColumn,
} from './columns'
import { integrationTriggerEnum, integrationTypeEnum } from './enums'
import { users } from './identity'
import { executionProfiles } from './profile'
import { workflows } from './workflow'

/**
 * Integrations — a ticket board the platform polls, and the record of what each poll did.
 *
 * An integration carries **no** repository, branch, model, caps or bundle: those all come from the
 * execution profile the mapping resolves to (FR-096). What lives here is how to reach the board,
 * how often to look, how much to start, and how the work from this board should be approached.
 */

export const integrations = pgTable(
  'integrations',
  {
    id: idColumn(),
    type: integrationTypeEnum('type').notNull(),
    name: text('name').notNull(),
    baseUrl: text('base_url').notNull(),
    /** Write-only from the panel — the value is never returned to a client. */
    credentialSecretArn: text('credential_secret_arn').notNull(),
    projectPrefix: text('project_prefix').notNull(),
    label: text('label').notNull(),
    extraFilters: jsonb('extra_filters'),
    /** Cannot be enabled without one (FR-133). */
    defaultOwnerUserId: uuid('default_owner_user_id').references(() => users.id),

    /**
     * **Not null (FR-158).** This is the layer describing how work from this board should be
     * approached, sitting between the profile's `prompt_preamble` and the ticket content in the
     * assembled prompt (FR-159). An integration cannot be enabled with it empty for the same
     * reason it cannot be enabled without a default owner: a run started from an empty intro is a
     * run nobody described. For a manually-started workflow the engineer's own prompt occupies
     * this layer instead (FR-165).
     */
    promptIntro: text('prompt_intro').notNull(),

    cronExpression: text('cron_expression').notNull(),
    timezone: text('timezone').notNull(),
    /** How many workflows one tick may start. */
    perTickCeiling: integer('per_tick_ceiling').notNull(),
    rollingPeriodCeiling: integer('rolling_period_ceiling').notNull(),
    rollingPeriodMinutes: integer('rolling_period_minutes').notNull(),
    enabled: disabledByDefaultColumn('enabled'),
    /** Drives auto-disable when a connector fails repeatedly (FR-105). */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    autoDisabledReason: text('auto_disabled_reason'),
    /** The registered schedule, kept in lockstep with `enabled` and `cronExpression` (FR-100). */
    scheduleArn: text('schedule_arn'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [uniqueIndex('integrations_name_key').on(table.name)],
)

/**
 * Ordered first-match rules from ticket to execution profile.
 *
 * A ticket matching no mapping is skipped with the reason recorded, never started under a guessed
 * profile (FR-130). The unique index on `(integration_id, position)` is what keeps "first match"
 * deterministic — two rules at the same position would make the winner depend on row order.
 */
export const integrationMappings = pgTable(
  'integration_mappings',
  {
    id: idColumn(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id),
    position: integer('position').notNull(),
    criteria: jsonb('criteria').notNull(),
    executionProfileId: uuid('execution_profile_id')
      .notNull()
      .references((): AnyPgColumn => executionProfiles.id),
    isDefault: disabledByDefaultColumn('is_default'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('integration_mappings_position_key').on(table.integrationId, table.position),
  ],
)

/**
 * Append-only history of every tick — the record that makes a silently-failing connector visible
 * (FR-105). A tick that examined tickets and started nothing is a fact worth keeping.
 */
export const integrationRuns = pgTable(
  'integration_runs',
  {
    id: idColumn(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id),
    trigger: integrationTriggerEnum('trigger').notNull(),
    startedAt: timestampColumn('started_at').notNull().defaultNow(),
    endedAt: timestampColumn('ended_at'),
    examinedCount: integer('examined_count').notNull().default(0),
    matchedCount: integer('matched_count').notNull().default(0),
    startedCount: integer('started_count').notNull().default(0),
    skippedCount: integer('skipped_count').notNull().default(0),
    /** Why each skipped ticket was skipped, including losing a claim race (FR-104, FR-130). */
    skipReasons: jsonb('skip_reasons'),
    error: text('error'),
  },
  (table) => [
    index('integration_runs_integration_idx').on(table.integrationId, table.startedAt.desc()),
  ],
)

/**
 * One row per ticket the platform has taken responsibility for.
 *
 * **The unique index on `(integration_id, external_id)` — not application logic — is what makes
 * exactly-once claiming hold** across restarts and overlapping ticks (FR-102, R8). Written in the
 * same transaction that creates the workflow, so a claim without a run cannot exist. Where two
 * integrations match one ticket the deterministic winner is the lower `integrations.id`, and the
 * loser records the collision in its run's `skip_reasons` (FR-104).
 */
export const ticketClaims = pgTable(
  'ticket_claims',
  {
    id: idColumn(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id),
    externalId: text('external_id').notNull(),
    workflowId: uuid('workflow_id').references((): AnyPgColumn => workflows.id),
    claimedAt: timestampColumn('claimed_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('ticket_claims_external_key').on(table.integrationId, table.externalId)],
)

export type Integration = typeof integrations.$inferSelect
export type NewIntegration = typeof integrations.$inferInsert
export type IntegrationMapping = typeof integrationMappings.$inferSelect
export type NewIntegrationMapping = typeof integrationMappings.$inferInsert
export type IntegrationRun = typeof integrationRuns.$inferSelect
export type NewIntegrationRun = typeof integrationRuns.$inferInsert
export type TicketClaim = typeof ticketClaims.$inferSelect
export type NewTicketClaim = typeof ticketClaims.$inferInsert
