/**
 * The control plane's jobs — every one of them invoked internally or by EventBridge Scheduler,
 * never over an inbound network surface (FR-035).
 *
 * Consumers import this barrel, never a module underneath it. `workflow-fixtures.ts`,
 * `integration-fixtures.ts` and `connector-fake.ts` are deliberately absent: they are test support,
 * and exporting them would put a fixture seeder — or a connector that ticks nothing and reports
 * success — one import away from a job.
 */

export { CREDENTIAL_STATE_A_RUN_WAITS_OUT, runJob, runWaitsForCredential, toError } from './run-job'
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

/**
 * The FR-019 rule about which states hand an agent credential back.
 *
 * Exported beside the jobs that apply it because it is the answer to a question asked from outside
 * this directory too — the pool view has to say which seats are held by parked runs (FR-074) — and
 * a second copy of "terminal, but not merely parked" is how the park case gets forgotten once.
 */
export {
  AGENT_CREDENTIAL_RETAINING_OUTCOME,
  isTerminalWorkflowState,
  releasesAgentCredential,
} from './agent-credential-release'

export {
  ADMISSIBLE_STATES,
  ADMISSION_LOCK_CLASS,
  ADMISSION_LOCK_KEY,
  ADMIT_WORKFLOW_JOB_NAME,
  admitWorkflow,
  agentCredentialFor,
  countLiveLeases,
  runAdmitWorkflow,
} from './admit-workflow'
export type {
  AdmissionOutcome,
  AdmissionWriter,
  AdmitWorkflowOptions,
  AdmittedWorkflow,
  AwaitingCredential,
  CoalescedAdmission,
  NotAdmissible,
  QueuedAdmission,
  WorkflowStarter,
} from './admit-workflow'

/**
 * How a wait for an agent credential is recorded and read back (003/FR-024, FR-028, FR-029).
 *
 * Exported because two jobs share it — admission writes the entry, the drain reads the clock off
 * it — and a copy in each would be two places for the discriminator to be spelled differently.
 */
export {
  CREDENTIAL_WAIT_EVENT,
  credentialWaitDetailFor,
  latestCredentialWait,
  recordCredentialWait,
} from './credential-wait'
export type {
  CredentialWaitReader,
  CredentialWaitWriter,
  RecordedCredentialWait,
} from './credential-wait'

export {
  CONCURRENCY_CEILING_VARIABLE,
  DEFAULT_CONCURRENCY_CEILING,
  readConcurrencyCeiling,
} from './concurrency-ceiling'

export {
  DEFAULT_CREDENTIAL_WAIT_LIMIT_MS,
  DEFAULT_DRAIN_LIMIT,
  drainQueue,
  DRAIN_QUEUE_JOB_NAME,
  runDrainQueue,
} from './drain-queue'
export type {
  DrainedWaiter,
  DrainQueueOptions,
  DrainQueueResult,
  DrainStartFailure,
  ExpiredCredentialWait,
} from './drain-queue'

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

/**
 * Starting a run, and starting one again (FR-036, 003/FR-039, 003/FR-041, 003/FR-043).
 *
 * {@link resumeWorkflow} is exported beside {@link startWorkflow} rather than under a heading of
 * its own because the two are one decision seen from either side of a pause: a resume starts the
 * *same* instance where 003/FR-039's stop retained it, and rebuilds from the snapshot where it
 * could not. Both take {@link StartWorkflowDependencies}, and a deployment that could reach one and
 * not the other would be able to pause a run it had no way of bringing back.
 */
export {
  createWorkflowStarter,
  RESUME_WORKFLOW_JOB_NAME,
  resumeWorkflow,
  runResumeWorkflow,
  runStartWorkflow,
  START_WORKFLOW_JOB_NAME,
  startWorkflow,
} from './start-workflow'
export type {
  AlreadyStartedWorkflow,
  NotResumable,
  NotStartable,
  RecoveredFromSnapshot,
  ResumeWorkflowOptions,
  ResumeWorkflowOutcome,
  StartedExistingInstance,
  StartedWorkflow,
  StartWorkflowDependencies,
  StartWorkflowOptions,
  StartWorkflowOutcome,
} from './start-workflow'

/**
 * The pause itself — a **stop with the disk retained**, and the park that ends one nobody came back
 * to (003/FR-039, 003/FR-044, 003/FR-073).
 *
 * Registered here for the reason the login reaper and the keep-alive sweep are: a job whose name is
 * only reachable from the module that defines it is a job a deployment forgets to invoke, and this
 * is the job that decides whether a paused run costs an idle instance or a snapshot.
 *
 * `QueueDrain` is deliberately **not** re-exported from `./pause-instance`. That module declares its
 * own, structurally identical to the one this barrel already publishes from `./teardown-workflow`,
 * and exporting both would be a name collision resolved by whichever line came last. One name for
 * one seam; the two declarations are assignable to each other, so a caller wiring the drain once
 * satisfies both jobs.
 */
export { PAUSE_INSTANCE_JOB_NAME, pauseInstance, runPauseInstance } from './pause-instance'
export type {
  NoInstanceToPause,
  NotPausable,
  ParkedRun,
  PauseInstanceOptions,
  PauseInstanceOutcome,
  PausePath,
  RecoverablePause,
  RefusedPause,
  StoppedPause,
} from './pause-instance'

/**
 * What a pause stands on when the instance is gone — the FR-043 fallback, and the precondition
 * every path that releases an environment observes first (003/FR-045).
 *
 * Exported beside the pause rather than kept behind it, because {@link resumableSnapshotFor} is the
 * question "could this run be rebuilt?" and that question is asked before anything is destroyed.
 * A caller that could reach `pauseInstance` and not this one could only find out by trying.
 */
export {
  giveUpEnvironment,
  resumableSnapshotFor,
  SNAPSHOT_RECOVERY_CAUSES,
} from './snapshot-recovery'
export type {
  GivenUpEnvironment,
  GiveUpEnvironmentOptions,
  GiveUpOutcome,
  RefusedGiveUp,
  ResumableSnapshot,
  SnapshotRecoveryCause,
} from './snapshot-recovery'

export {
  confirmDurability,
  runTeardownWorkflow,
  TEARDOWN_BUDGET_MS,
  TEARDOWN_WORKFLOW_JOB_NAME,
  teardownWorkflow,
} from './teardown-workflow'
export type {
  AgentCredentialDisposition,
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
  COOLING_OFF_RETRY_MS,
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
  ReleasedCredentialSeat,
  ReleasedLease,
  ReturnedCredential,
  TerminatedInstance,
} from './reconcile'

export {
  abandonStaleValidationRuns,
  completeBundleValidation,
  runValidateBundle,
  startBundleValidation,
  terminateFinishedValidationInstances,
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
  findIntegration,
  findLastCompletedRun,
  findTicketOwner,
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
  TicketOwnership,
  TicketOwnershipReason,
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

/**
 * The wall-clock login reaper (003/FR-071).
 *
 * Registered here, and implemented in `../credentials/login/`, for the reason the FR-019 release
 * rule above is exported from this directory: a schedule needs one place to find the jobs it may
 * invoke, and a job whose name is only reachable from the module that defines it is a job a
 * deployment forgets to schedule. Nothing else about it belongs here — the mechanism is the login
 * directory's, and its barrel is where it is documented.
 */
export { REAP_LOGIN_ENVIRONMENTS_JOB_NAME, reapLoginEnvironments } from '../credentials/login'
export type {
  ReapLoginEnvironmentsOptions,
  ReapLoginEnvironmentsResult,
} from '../credentials/login'

/**
 * The keep-alive sweep (003/FR-035, SC-009), registered here for the same reason the login reaper
 * above is.
 *
 * A schedule needs one place to find the jobs it may invoke, and a job whose name is only reachable
 * from the module that defines it is a job a deployment forgets to schedule. That failure is
 * particularly bad here: keep-alive is the *only* mechanism that stops a seat expiring through
 * disuse (FR-035 says so explicitly, and `select.ts` explains why least-recently-used selection
 * cannot), so an unregistered keep-alive is a pool that reports itself perfectly healthy for
 * exactly as long as it takes every idle login to lapse. Nothing else about it belongs here — the
 * mechanism is `../credentials/liveness/`, and its barrel is where it is documented.
 *
 * The seam and its default are exported beside the sweep because the composition root has to wire
 * one, and {@link createRefusingCredentialExerciser} is what an unwired deployment gets: a
 * keep-alive that fails loudly rather than one that reports success without reaching a provider.
 */
export {
  createRefusingCredentialExerciser,
  KEEP_ALIVE_JOB_NAME,
  sweepKeepAlive,
} from '../credentials/liveness'
export type {
  CredentialExerciser,
  KeepAliveAttempt,
  KeepAliveSweepResult,
  SweepKeepAliveOptions,
} from '../credentials/liveness'

/**
 * The FR-056 administrator alerts, on their own schedule (003/FR-056, SC-009).
 *
 * Registered here for the reason the login reaper and the keep-alive sweep are — a schedule needs
 * one place to find the jobs it may invoke — and the failure of *not* registering it is the one
 * this feature is most exposed to: `sisyphus-notify` can decide which alerts are due and can send
 * them, and until this job existed nothing ever asked it. A pool with a broken seat, a seat that
 * was never logged in and a lease held for a day would have reported all three on a screen nobody
 * had a reason to open.
 */
export {
  alertSubjectFor,
  CREDENTIAL_ALERTS_JOB_NAME,
  readAlertRecipients,
  runCredentialAlerts,
  sweepCredentialAlerts,
} from './credential-alerts'
export type {
  CredentialAlertReader,
  SweepCredentialAlertsOptions,
  SweepCredentialAlertsResult,
} from './credential-alerts'

export {
  integrationIdFromScheduleName,
  KEEP_ALIVE_SCHEDULE_EXPRESSION,
  KEEP_ALIVE_SCHEDULE_NAME,
  PLATFORM_SCHEDULE_PREFIX,
  PLATFORM_SCHEDULES,
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
