/**
 * Report-back to the machine surface (T062, T071).
 *
 * Consumers import from here and never from the modules behind it. Two things
 * the barrel is holding in place:
 *
 * - **The contract enters the executor as types only.** `client.ts` is the one
 *   file that names `@bluetel-ai/sisyphus-api`, and it names it with
 *   `import type`. `boundary.test.ts` bundles this directory and fails if a
 *   driver or an ORM appears in the output (FR-005, FR-006).
 * - **Free text on the wire is `SanitisedText`.** The reporting types narrow
 *   the router's `string` fields to the branded type, so an unsanitised
 *   message cannot be reported without a compile error (FR-045, FR-089).
 */

export {
  createBackoff,
  DEFAULT_BACKOFF_FACTOR,
  DEFAULT_INITIAL_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
  sleep,
} from './backoff'
export type { Backoff, BackoffOptions, Sleeper } from './backoff'

export {
  createHttpMachineTransport,
  createMachineSurfaceClient,
  crossWorkflowSegmentError,
} from './client'
export type {
  AcknowledgeCommandInput,
  AppendLogSegmentInput,
  BootstrapPhaseInput,
  BootstrapPhaseReport,
  CredentialRotationReport,
  CredentialRotationResult,
  ExternalActionClaim,
  ExternalActionInput,
  FetchedAgentCredentialResult,
  HeartbeatInput,
  HttpMachineTransportOptions,
  MachineSurfaceClient,
  MachineSurfaceClientOptions,
  MachineSurfaceTransport,
  PendingCommands,
  RegisterArtifactInput,
  RegisterSnapshotInput,
  RenewedCredential,
  SkillReferenceInput,
  SnapshotParkInput,
  SnapshotParkReport,
  TerminalInput,
  TerminalReport,
} from './client'

export { createOutbox, DEFAULT_MAX_ENTRIES, OutboxFullError } from './outbox'
export type { Outbox, OutboxCall, OutboxOptions, OutboxSaturation } from './outbox'

export {
  buildReviewerSummary,
  createArtifactSummarySink,
  incompleteSummaryError,
  publishReviewerSummary,
} from './summary'
export type {
  ArtifactSummarySinkOptions,
  EntrySummary,
  ReviewerSummary,
  ReviewerSummaryInput,
  ReviewerSummarySink,
} from './summary'
