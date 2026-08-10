/**
 * The assembled run — the trunk every other directory in this app hangs from (T173–T178, FR-203).
 *
 * Consumers import this barrel, never a module underneath it, and in practice there is exactly one
 * consumer: `src/main.ts`. That is the point. Composition lives here, in modules with colocated
 * tests, rather than in an entry point nothing can exercise — an assembly that can only be run by
 * launching an instance is an assembly nobody checks.
 */

export { assembleRun, noWorkflowPorts, validationModeUnsupportedError } from './assemble'
export type { AssembledRun, AssembleRunOptions, ExecutorEnvironment } from './assemble'

export {
  bootstrapRun,
  BUNDLE_CREDENTIAL_SCAN_LIMITS,
  bundleCredentialNote,
  DEFAULT_BUNDLE_SUBDIRECTORY,
  registerBundleCredentials,
  setupBundleReference,
  workspaceEntries,
} from './bootstrap'
export type { BootstrappedRun, BundleCredentialScan, RunBootstrapOptions } from './bootstrap'

export {
  DELIVERY_ENTRY_STEP,
  prepareDeliveryEntries,
  refusingForge,
  undeliverableEntryError,
  unknownEntryRepositoryError,
  unobservedDeliveryEntryError,
  WORKING_TREE_STATUS,
} from './delivery-entries'
export type {
  DeliveryEntryEvidence,
  DeliveryEntryObservation,
  DeliveryEntryProbe,
  DeliveryEntryProbeOutcome,
  PrepareDeliveryEntriesInput,
  PreparedDeliveryEntries,
} from './delivery-entries'

export { dispatchWorkflow, missingWorkflowPortsError } from './dispatch'
export type {
  AutonomousPorts,
  DelegatedPorts,
  ReviewPorts,
  WorkflowCommonInput,
  WorkflowDispatchInput,
  WorkflowDispatchResult,
} from './dispatch'

export {
  createSurfacePhaseReporter,
  frameText,
  runExecutor,
  supervisionTransportFor,
} from './execute'
export type {
  ExecutorRunResult,
  RunExecutorOptions,
  WorkflowPortSelection,
  WorkflowPortsContext,
  WorkflowPortsFactory,
} from './execute'

export {
  createForgeCredential,
  createProcessCredentialFiller,
  CREDENTIAL_FILL_ENV,
  credentialDiagnostic,
  credentialQuery,
  DEFAULT_CREDENTIAL_FILL_TIMEOUT_MS,
  ForgeCredentialError,
  MAX_CREDENTIAL_DIAGNOSTIC_LENGTH,
  passwordFrom,
} from './forge-credential'
export type {
  CredentialFillCommand,
  CredentialFiller,
  CredentialFillResult,
  ForgeCredential,
  ForgeCredentialFailure,
  ForgeCredentialOptions,
} from './forge-credential'

export { createHeartbeatLoop, HEARTBEAT_INTERVAL_MS } from './heartbeat'
export type { HeartbeatLoop, HeartbeatLoopOptions, HeartbeatState } from './heartbeat'

export { createRunExternalActionLedgers } from './ledgers'
export type { RunExternalActionLedgers } from './ledgers'

export { createParkReporter, parkLogLine } from './park-report'
export type { ParkReporterOptions } from './park-report'
