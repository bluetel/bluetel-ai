/**
 * The platform's closed vocabularies.
 *
 * This barrel is the only supported import path: consumers take `@bluetel-ai/sisyphus-api/client`
 * or `/db`, which re-export from here, and never reach into a module file directly. Everything in
 * here is plain data with no runtime dependencies, so it is safe in a browser bundle as well as on
 * the executor.
 *
 * Each vocabulary is mirrored by a Postgres enum in `src/db/schema/enums.ts`, generated from these
 * tuples — so adding a value is a migration plus one edit, and a stale literal fails `typecheck`
 * rather than failing at run time (FR-009).
 *
 * **The direction of that generation is the constraint this directory exists to hold.** The tuple
 * is the source and `pgEnum` is built from it, never the reverse, because this directory must stay
 * free of `drizzle-orm` — the panel bundles it. `index.test.ts` asserts that no module here imports
 * anything outside the directory at all, which is what stops the dependency being reintroduced by
 * a well-meaning edit rather than merely discouraged by this comment.
 */

export { ARTIFACT_KINDS, isArtifactKind } from './artifact-kind'
export type { ArtifactKind } from './artifact-kind'

export {
  BOOTSTRAP_PHASES,
  isBootstrapPhase,
  isValidationBootstrapPhase,
  VALIDATION_BOOTSTRAP_PHASES,
} from './bootstrap-phase'
export type { BootstrapPhase, ValidationBootstrapPhase } from './bootstrap-phase'

export { BOOTSTRAP_PHASE_OUTCOMES, isBootstrapPhaseOutcome } from './bootstrap-phase-outcome'
export type { BootstrapPhaseOutcome } from './bootstrap-phase-outcome'

export { CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL, isClaudeModel } from './claude-model'
export type { ClaudeModel } from './claude-model'

export {
  CORRECTION_DELIVERY_OUTCOMES,
  isCorrectionDeliveryOutcome,
  REPORTABLE_CORRECTION_DELIVERY_OUTCOMES,
} from './correction-delivery-outcome'
export type {
  CorrectionDeliveryOutcome,
  ReportableCorrectionDeliveryOutcome,
} from './correction-delivery-outcome'

export { CREDENTIAL_RELEASE_REASONS, isCredentialReleaseReason } from './credential-release-reason'
export type { CredentialReleaseReason } from './credential-release-reason'

export { CREDENTIAL_STATES, isCredentialState } from './credential-state'
export type { CredentialState } from './credential-state'

export { createEnumGuard } from './enum-guard'

export { ENTRY_RESULTS, isEntryResult } from './entry-result'
export type { EntryResult } from './entry-result'

export {
  EXTERNAL_ACTION_KINDS,
  EXTERNAL_ACTION_RESULTS,
  isExternalActionKind,
  isExternalActionResult,
} from './external-action'
export type { ExternalActionKind, ExternalActionResult } from './external-action'

export { INTEGRATION_TYPES, isIntegrationType } from './integration-type'
export type { IntegrationType } from './integration-type'

export { isNotificationEvent, NOTIFICATION_EVENTS } from './notification-event'
export type { NotificationEvent } from './notification-event'

export { DEFAULT_PURCHASE_MODE, isPurchaseMode, PURCHASE_MODES } from './purchase-mode'
export type { PurchaseMode } from './purchase-mode'

export { isReviewFindingSeverity, REVIEW_FINDING_SEVERITIES } from './review-finding-severity'
export type { ReviewFindingSeverity } from './review-finding-severity'

export { isReviewVerdict, REVIEW_VERDICTS } from './review-verdict'
export type { ReviewVerdict } from './review-verdict'

export { isSkillName, SKILL_NAMES } from './skill-name'
export type { SkillName } from './skill-name'

export { isSnapshotBoundary, SNAPSHOT_BOUNDARIES } from './snapshot-boundary'
export type { SnapshotBoundary } from './snapshot-boundary'

export {
  isSupervisionDeliveryOutcome,
  REPORTABLE_SUPERVISION_DELIVERY_OUTCOMES,
  SUPERVISION_DELIVERY_OUTCOMES,
} from './supervision-delivery-outcome'
export type {
  ReportableSupervisionDeliveryOutcome,
  SupervisionDeliveryOutcome,
} from './supervision-delivery-outcome'

export { isTerminalOutcome, TERMINAL_OUTCOMES } from './terminal-outcome'
export type { TerminalOutcome } from './terminal-outcome'

export { DEFAULT_USER_ROLE, isUserRole, USER_ROLES } from './user-role'
export type { UserRole } from './user-role'

export { isValidationOutcome, VALIDATION_OUTCOMES } from './validation-outcome'
export type { ValidationOutcome } from './validation-outcome'

export {
  ACTIVE_WORKFLOW_STATES,
  isWorkflowState,
  TERMINAL_WORKFLOW_STATES,
  WORKFLOW_STATES,
} from './workflow-state'
export type { ActiveWorkflowState, WorkflowState } from './workflow-state'

export { isWorkflowType, WORKFLOW_TYPES } from './workflow-type'
export type { WorkflowType } from './workflow-type'
