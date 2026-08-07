/**
 * The machine surface — executor report-back, authorised by a workflow-scoped credential.
 *
 * `machineSurfaceRouter` is what `root.ts` mounts as `machineRouter` at `/api/machine`, separately
 * from the interactive surface. The individual reporters are exported alongside it so the
 * reconciler's in-process caller and the contract tests can reach one without a router, and so the
 * cross-workflow guard is importable as the single checked entry point it is meant to be.
 *
 * Consumers import this barrel, never a module underneath it.
 */

export { registerArtifact, REGISTER_ARTIFACT_PATH, artifactLocationError } from './artifacts'

export {
  credentialSigningKey,
  SCOPED_CREDENTIAL_ALGORITHM,
  SCOPED_CREDENTIAL_AUDIENCE,
  SCOPED_CREDENTIAL_ISSUER,
  SCOPED_CREDENTIAL_MAX_LIFETIME_MS,
  SCOPED_CREDENTIAL_WINDOW_MS,
  VALIDATION_SUBJECT_PREFIX,
  validationSubject,
  WORKFLOW_SUBJECT_PREFIX,
  workflowIdFromSubject,
  workflowSubject,
} from './credential-claims'

export {
  bearerTokenFrom,
  CREDENTIAL_HEADER,
  CREDENTIAL_SCHEME,
  createScopedCredentialResolver,
  inspectScopedCredential,
  verifyScopedCredential,
} from './credential-verification'
export type {
  ScopedCredentialJwtOptions,
  ScopedCredentialJwtResult,
  ScopedCredentialJwtVerifier,
  ScopedCredentialOutcome,
  ScopedCredentialRefusal,
  ScopedCredentialResolverOptions,
} from './credential-verification'

export {
  CREDENTIAL_RENEWAL_WINDOW_MS,
  credentialRevokedError,
  RENEW_CREDENTIAL_PATH,
  renewCredential,
  terminalRenewalError,
} from './credential'
export type { RenewedCredential } from './credential'

export {
  honestTerminalOutcome,
  loadEntryStandings,
  REPORT_ENTRY_CHECKOUT_PATH,
  reportEntryCheckout,
  reportEntryCheckoutInput,
  summariseEntryResults,
} from './entries'
export type {
  EntryCheckoutReport,
  EntryResultSummary,
  EntryStanding,
  HonestTerminalOutcome,
  ReportEntryCheckoutInput,
} from './entries'

export { REPORT_ENTRY_RESULT_PATH, reportEntryResult } from './entry-results'
export type { EntryResultReport } from './entry-results'

export {
  EXTERNAL_ACTION_IDEMPOTENCY_INDEX,
  reportExternalAction,
  reportExternalActionProcedure,
  supersedesExternalActionResult,
} from './external-actions'
export type { ExternalAction, ExternalActionReport } from './external-actions'

export {
  firstRow,
  isTerminalState,
  loadMachineWorkflow,
  requireEntryInWorkflow,
  resolveOptionalEntry,
} from './guard'
export type { MachineContext } from './guard'

export {
  fourthIterationError,
  iterationHistory,
  ITERATION_ORDINAL_BOUND,
  ITERATION_ORDINAL_CONSTRAINT,
  REPORT_ITERATION_PATH,
  reportIteration,
  reportIterationProcedure,
} from './iterations'
export type { Iteration, IterationReport, ReviewFinding } from './iterations'

export { appendLogSegment, invalidSegmentWindowError } from './log-segments'
export type { AppendedLogSegment } from './log-segments'

export {
  heartbeat,
  REPORT_BOOTSTRAP_PHASE_PATH,
  reportBootstrapPhase,
  reportTerminal,
  terminalHeartbeatError,
} from './reporting'
export type { HeartbeatAcknowledgement, ReportWriter, TerminalReport } from './reporting'

export { reportReviewerSummary } from './reviewer-summary'
export type { ReviewerSummaryReport } from './reviewer-summary'

export {
  REPORT_SKILL_REFERENCE_PATH,
  reportSkillReference,
  reportSkillReferenceProcedure,
} from './skill-references'
export type { SkillReference, SkillReferenceReport } from './skill-references'

export {
  chainSessionIds,
  missingSnapshotState,
  REGISTER_SNAPSHOT_PATH,
  registerSnapshot,
  requireSessionInChain,
  SNAPSHOT_RETENTION_DAYS,
  snapshotExpiry,
} from './snapshot'
export type { MissingSnapshotState, RegisteredSnapshot } from './snapshot'

export {
  reportSnapshotPark,
  reportSnapshotParkProcedure,
  snapshotParkDetailFor,
} from './snapshot-park'
export type { SnapshotParkReport } from './snapshot-park'

export { machineSurfaceRouter } from './router'
export type { MachineSurfaceRouter } from './router'
