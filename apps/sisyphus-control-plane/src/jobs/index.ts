/**
 * The control plane's jobs — every one of them invoked internally or by EventBridge Scheduler,
 * never over an inbound network surface (FR-035).
 *
 * Consumers import this barrel, never a module underneath it. `workflow-fixtures.ts`,
 * `integration-fixtures.ts` and `connector-fake.ts` are deliberately absent: they are test support,
 * and exporting them would put a fixture seeder — or a connector that ticks nothing and reports
 * success — one import away from a job.
 */

export { runJob, toError } from './run-job'
export type { JobContext, JobFailure, JobHandler, JobOutcome, JobSuccess } from './run-job'

export {
  BOOTSTRAP_ADMINS_JOB_NAME,
  BOOTSTRAP_GOOGLE_SUBJECT_PREFIX,
  BOOTSTRAP_ROLE_CHANGE_REASON,
  normaliseBootstrapEmails,
  reconcileBootstrapAdmins,
  runBootstrapAdmins,
  runBootstrapAdminsFromEnv,
} from './bootstrap-admins'
export type {
  BootstrapAdminOutcome,
  BootstrapAdminsResult,
  BootstrapWriter,
  ReconcileBootstrapAdminsOptions,
} from './bootstrap-admins'

export {
  ADMISSION_LOCK_CLASS,
  ADMISSION_LOCK_KEY,
  ADMIT_WORKFLOW_JOB_NAME,
  admitWorkflow,
  countLiveLeases,
  runAdmitWorkflow,
} from './admit-workflow'
export type {
  AdmissionOutcome,
  AdmissionWriter,
  AdmitWorkflowOptions,
  AdmittedWorkflow,
  CoalescedAdmission,
  NotAdmissible,
  QueuedAdmission,
  WorkflowStarter,
} from './admit-workflow'

export {
  CONCURRENCY_CEILING_VARIABLE,
  DEFAULT_CONCURRENCY_CEILING,
  readConcurrencyCeiling,
} from './concurrency-ceiling'

export { DEFAULT_DRAIN_LIMIT, drainQueue, DRAIN_QUEUE_JOB_NAME, runDrainQueue } from './drain-queue'
export type { DrainQueueOptions, DrainQueueResult, DrainStartFailure } from './drain-queue'

export { parseInstanceTag, validationInstanceTag, workflowInstanceTag } from './instance-tag'
export type {
  InstanceTag,
  UnattributedInstanceTag,
  ValidationInstanceTag,
  WorkflowInstanceTag,
} from './instance-tag'

export { encodeUserData, MAX_USER_DATA_BYTES, WORKSPACE_ROOT } from './job-envelope'
export type {
  EnvelopeJob,
  EnvelopePrompt,
  EnvelopeResumeFromSnapshot,
  EnvelopeSetupBundle,
  EnvelopeWorkspace,
  EnvelopeWorkspaceEntry,
  JobEnvelope,
  ValidationJobEnvelope,
  WorkflowJobEnvelope,
} from './job-envelope'

export {
  createWorkflowStarter,
  runStartWorkflow,
  START_WORKFLOW_JOB_NAME,
  startWorkflow,
} from './start-workflow'
export type {
  AlreadyStartedWorkflow,
  NotStartable,
  StartedWorkflow,
  StartWorkflowDependencies,
  StartWorkflowOptions,
  StartWorkflowOutcome,
} from './start-workflow'

export {
  confirmDurability,
  runTeardownWorkflow,
  TEARDOWN_BUDGET_MS,
  TEARDOWN_WORKFLOW_JOB_NAME,
  teardownWorkflow,
} from './teardown-workflow'
export type {
  AlreadyReleasedTeardown,
  DeferredTeardown,
  DurabilityBuckets,
  ForcedTeardown,
  MissingObject,
  NotTerminalTeardown,
  QueueDrain,
  ReleasedTeardown,
  TeardownOutcome,
  TeardownWorkflowOptions,
} from './teardown-workflow'

export {
  HEARTBEAT_LAPSE_MS,
  PROVISIONING_GRACE_MS,
  RECONCILE_JOB_NAME,
  reconcile,
  runReconcile,
} from './reconcile'
export type {
  MovedWorkflow,
  ReconcileOptions,
  ReconcileResult,
  ReleasedLease,
  TerminatedInstance,
} from './reconcile'

export {
  abandonStaleValidationRuns,
  completeBundleValidation,
  runValidateBundle,
  startBundleValidation,
  VALIDATE_BUNDLE_JOB_NAME,
  VALIDATION_BUDGET_MS,
  VALIDATION_PHASES,
} from './validate-bundle'
export type {
  AbandonedValidation,
  CompletedValidation,
  CompleteBundleValidationOptions,
  FailedValidationProvisioning,
  ProvisionedValidation,
  StartBundleValidationOptions,
  StartBundleValidationOutcome,
  ValidationPhase,
  ValidationPhaseResult,
  ValidationPhaseResults,
} from './validate-bundle'

export {
  assembleIntegrationPrompt,
  assemblePrompt,
  hasNoTask,
  NO_DESCRIPTION,
  PROMPT_SECTIONS,
  TRUNCATION_NOTICE,
} from './assemble-prompt'
export type {
  AssembledPrompt,
  AssembleIntegrationPromptOptions,
  AssemblePromptInput,
} from './assemble-prompt'

export {
  assertRedactorConformance,
  boundComments,
  checkRedactorConformance,
  conformanceCasesFor,
  createRefusingPromptRedactor,
  DEFAULT_STORED_COMMENT_CHARACTERS,
  DEFAULT_STORED_COMMENTS,
  PROMPT_REDACTOR_NOT_CONFIGURED,
  REDACTION_CONFORMANCE_CASES,
  redactPromptParts,
} from './prompt-redact'
export type {
  BoundedComments,
  CommentBound,
  PromptRedactor,
  RedactedPromptParts,
  RedactionConformanceCase,
  RedactPromptPartsOptions,
} from './prompt-redact'

/**
 * The FR-192 seam.
 *
 * `connector-registry.ts` is the map and nothing else; `registered-connectors.ts` is the composition
 * root that fills it in and the only module in this app that names a board. Both are exported, so a
 * deployment can take the registry as shipped or build a narrower one, and neither choice reaches
 * into a module underneath this barrel.
 */
export {
  connectorFor,
  createConnectorRegistry,
  unregisteredConnectorMessage,
} from './connector-registry'
export type {
  ConnectorFactory,
  ConnectorFactoryInput,
  ConnectorRegistry,
  IntegrationType,
} from './connector-registry'

export {
  createRegisteredConnectorRegistry,
  jiraConnectorFactory,
  REGISTERED_CONNECTOR_TYPES,
  widenConnectorConfig,
} from './registered-connectors'

export {
  claimAndStart,
  closeRun,
  countStartedSince,
  findCompetingClaim,
  findIntegration,
  findLastCompletedRun,
  findOpenRun,
  listIntegrations,
  listMappings,
  openRun,
  readProfileLaunch,
  resolveOwnerUserId,
} from './integration-store'
export type {
  AlreadyClaimed,
  ClaimAndStartInput,
  ClaimedAndStarted,
  ClaimOutcome,
  IntegrationReader,
  IntegrationWriter,
  ProfileLaunch,
  RecordedSkip,
  RunTotals,
} from './integration-store'

export {
  connectorConfigFor,
  INTEGRATION_TICK_JOB_NAME,
  integrationTick,
  runIntegrationTick,
} from './integration-tick'
export type {
  IntegrationTickDependencies,
  IntegrationTickOptions,
  TickCompleted,
  TickFailed,
  TickNotRun,
  TickOutcome,
} from './integration-tick'

/**
 * The listener on the other end of `NOTIFY sisyphus_integration_tick` (FR-035, FR-097).
 *
 * Exported beside the tick because a deployment that starts one without the other has an admin
 * panel whose "Run now" button is answered and then dropped — which is exactly the state this
 * platform was in before it was wired.
 */
export {
  createManualTicker,
  createSqlTickSignalSource,
  DEFAULT_PROBE_TIMEOUT_MS,
  isProbePayload,
  probePayload,
  runTickTransportProbe,
  SIGNALLED_TICK_TRIGGER,
  startTickSignalListener,
  TICK_SIGNAL_CHANNEL,
  TICK_TRANSPORT_PROBE_JOB_NAME,
  TRANSPORT_UNVERIFIED_REASON,
} from './integration-tick-signal'
export type {
  ListenCapableSql,
  TickSignalListener,
  TickSignalListenerOptions,
  TickSignalSource,
  TickSignalSubscription,
  TransportVerification,
} from './integration-tick-signal'

export {
  AUTO_DISABLED_PREFIX,
  autoDisabledReason,
  DEFAULT_FAILURE_THRESHOLD,
  recordRunOutcome,
  wasAutoDisabled,
} from './integration-health'
export type { HealthWriter, IntegrationHealth, RecordRunOutcomeInput } from './integration-health'

/**
 * What one run's compute actually cost (FR-041).
 *
 * `summariseComputeCost` is exported beside the job rather than hidden behind it, and deliberately:
 * it prices a lease that is still live as well as one that has been released, so a running figure
 * can be shown without `recordCostBasis` committing one. The rate card is a value a deployment
 * builds — `createRateCard` and `rateCardKey` are its whole vocabulary — so nothing under this
 * barrel has to know a price.
 */
export {
  billableMs,
  computeCost,
  COST_BASIS_JOB_NAME,
  createRateCard,
  rateCardKey,
  recordCostBasis,
  runRecordCostBasis,
  summariseComputeCost,
} from './cost-basis'
export type {
  AlreadyRecordedCostBasis,
  ComputeCostBasis,
  ComputeRateCard,
  ComputeRateKey,
  CostBasisOutcome,
  NoLeaseCostBasis,
  RecordCostBasisOptions,
  RecordedCostBasis,
  UnpricedCostBasis,
  UnsettledCostBasis,
} from './cost-basis'

export {
  integrationIdFromScheduleName,
  removeSchedule,
  runSyncSchedules,
  SCHEDULE_NAME_PREFIX,
  scheduleDefinitionFor,
  scheduleNameFor,
  schedulePayloadFor,
  SYNC_SCHEDULES_JOB_NAME,
  syncSchedules,
  toSchedulerExpression,
} from './sync-schedules'
export type { ScheduleAction, SyncSchedulesOptions, SyncSchedulesResult } from './sync-schedules'
