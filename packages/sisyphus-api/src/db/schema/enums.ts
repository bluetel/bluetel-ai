import { pgEnum } from 'drizzle-orm/pg-core'

import {
  ARTIFACT_KINDS,
  BOOTSTRAP_PHASE_OUTCOMES,
  BOOTSTRAP_PHASES,
  CLAUDE_MODELS,
  CORRECTION_DELIVERY_OUTCOMES,
  ENTRY_RESULTS,
  EXTERNAL_ACTION_KINDS,
  EXTERNAL_ACTION_RESULTS,
  INTEGRATION_TYPES,
  NOTIFICATION_EVENTS,
  PURCHASE_MODES,
  REVIEW_FINDING_SEVERITIES,
  REVIEW_VERDICTS,
  SKILL_NAMES,
  SNAPSHOT_BOUNDARIES,
  SUPERVISION_DELIVERY_OUTCOMES,
  TERMINAL_OUTCOMES,
  USER_ROLES,
  WORKFLOW_STATES,
  WORKFLOW_TYPES,
} from '../../enums'

/**
 * Every Postgres enum type in the schema.
 *
 * **This file declares database types; it does not define vocabularies.** Every closed set the
 * platform shares with the panel or the executor lives in `src/enums/` as a plain string tuple,
 * and the `pgEnum`s below are generated from those tuples — so a value cannot exist in the
 * database and not in TypeScript (FR-009), and the panel can bundle the vocabulary without
 * bundling Drizzle.
 *
 * The direction matters and is only ever this way round. `src/enums/` may not import
 * `drizzle-orm`; `src/enums/index.test.ts` fails if it ever does. Anything declared here with a
 * literal array is a set nothing outside the database needs to name — a column's own closed set,
 * with no client or executor consumer. When one acquires a consumer, the tuple moves to
 * `src/enums/` and this file imports it, rather than the value being restated on the far side.
 *
 * They all live in one file rather than beside their tables because a Postgres enum type is
 * database-wide: one file makes the whole vocabulary reviewable and name collisions impossible.
 *
 * Adding a value to any of these is a migration. That is deliberate.
 */

// --- Generated from src/enums/ -------------------------------------------------------------

export const workflowStateEnum = pgEnum('workflow_state', WORKFLOW_STATES)
export const workflowTypeEnum = pgEnum('workflow_type', WORKFLOW_TYPES)
export const terminalOutcomeEnum = pgEnum('terminal_outcome', TERMINAL_OUTCOMES)
export const userRoleEnum = pgEnum('user_role', USER_ROLES)
export const purchaseModeEnum = pgEnum('purchase_mode', PURCHASE_MODES)
export const claudeModelEnum = pgEnum('claude_model', CLAUDE_MODELS)
export const integrationTypeEnum = pgEnum('integration_type', INTEGRATION_TYPES)
export const bootstrapPhaseEnum = pgEnum('bootstrap_phase', BOOTSTRAP_PHASES)
export const bootstrapPhaseOutcomeEnum = pgEnum('bootstrap_phase_outcome', BOOTSTRAP_PHASE_OUTCOMES)
export const entryResultEnum = pgEnum('entry_result', ENTRY_RESULTS)
export const snapshotBoundaryEnum = pgEnum('snapshot_boundary', SNAPSHOT_BOUNDARIES)
export const skillNameEnum = pgEnum('skill_name', SKILL_NAMES)
export const artifactKindEnum = pgEnum('artifact_kind', ARTIFACT_KINDS)
export const correctionDeliveryOutcomeEnum = pgEnum(
  'correction_delivery_outcome',
  CORRECTION_DELIVERY_OUTCOMES,
)
export const supervisionDeliveryOutcomeEnum = pgEnum(
  'supervision_delivery_outcome',
  SUPERVISION_DELIVERY_OUTCOMES,
)
export const reviewVerdictEnum = pgEnum('review_verdict', REVIEW_VERDICTS)
export const reviewFindingSeverityEnum = pgEnum(
  'review_finding_severity',
  REVIEW_FINDING_SEVERITIES,
)
export const externalActionKindEnum = pgEnum('external_action_kind', EXTERNAL_ACTION_KINDS)
export const externalActionResultEnum = pgEnum('external_action_result', EXTERNAL_ACTION_RESULTS)
export const notificationEventEnum = pgEnum('notification_event', NOTIFICATION_EVENTS)

// --- Identity ------------------------------------------------------------------------------

/** What a `role_changes` row records. Never edited or deleted (FR-177). */
export const roleChangeEnum = pgEnum('role_change', [
  'grant_admin',
  'revoke_admin',
  'activate',
  'deactivate',
])

// --- Bundles -------------------------------------------------------------------------------

/** The result of proving a bundle without starting an agent (FR-147, FR-148). */
export const validationOutcomeEnum = pgEnum('validation_outcome', ['passed', 'failed'])

// --- Integrations --------------------------------------------------------------------------

/** What caused an integration tick. */
export const integrationTriggerEnum = pgEnum('integration_trigger', ['scheduled', 'manual'])

// --- Workflow ------------------------------------------------------------------------------

/**
 * The append-only timeline the panel renders. Every state transition is timestamped and attributed
 * (FR-064).
 */
export const workflowEventEnum = pgEnum('workflow_event', [
  'created',
  'queued',
  'admitted',
  'provisioned',
  'started',
  'paused',
  'corrected',
  'resumed',
  'snapshot_registered',
  'interrupted',
  'parked',
  'capped',
  'succeeded',
  'failed',
  'cancelled',
  'needs_attention',
  'access_denied',
  'reassignment_required',
])

/** Who caused a timeline entry. `user` is the only one carrying an `actor_user_id`. */
export const actorTypeEnum = pgEnum('actor_type', [
  'user',
  'executor',
  'control_plane',
  'reconciler',
  'integration',
])

// --- Supervision ---------------------------------------------------------------------------

export const supervisionCommandEnum = pgEnum('supervision_command', ['pause', 'resume', 'stop'])

// --- Notification --------------------------------------------------------------------------

/** Slack direct message is the only channel in scope (FR-136). */
export const notificationChannelEnum = pgEnum('notification_channel', ['slack_dm'])

/**
 * `unnotifiable` is a recorded outcome, not an error: a user with no resolvable Slack identity is
 * surfaced in the panel and must not cause the workflow to fail (FR-140).
 */
export const notificationOutcomeEnum = pgEnum('notification_outcome', [
  'delivered',
  'failed',
  'unnotifiable',
])
