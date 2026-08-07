/**
 * The workflow surface — launching a run and reading everything about one.
 *
 * `workflowRouter` is what `root.ts` mounts under `workflow`. The pieces are exported alongside it
 * so the control plane's in-process caller and the contract tests can reach one read without
 * assembling a router, and so `queries.ts` — where FR-190 is enforced for every workflow read — is
 * importable as the single scoped entry point it is meant to be.
 *
 * Consumers import this barrel, never a module underneath it.
 */

export {
  bundleNotSelectableError,
  bundleVersionNotAvailableError,
  requireSelectableBundleVersion,
} from './ad-hoc-bundle'
export type { BundleReader } from './ad-hoc-bundle'

export {
  adHocWorkspaceName,
  deriveSubdirectory,
  resolveAdHocJobSpec,
  uncappedAutonomousError,
  willSaveAsProfile,
} from './ad-hoc-plan'
export type { AdHocJobSpec } from './ad-hoc-plan'

export {
  copyWorkspaceEntries,
  listLaunchableWorkspaces,
  materialiseRepositoryWorkspace,
  requireLaunchableWorkspaceVersion,
  resolveAdHocWorkspace,
  workspaceNotAvailableError,
  workspaceNotLaunchableError,
} from './ad-hoc-workspace'
export type {
  LaunchableWorkspace,
  ResolvedAdHocWorkspace,
  WorkspaceWriter,
} from './ad-hoc-workspace'

export { escapeSearchTerm, toWorkflowPage, workflowListConditions } from './filters'
export type { WorkflowPage } from './filters'

/**
 * Reading a completed run back as it was launched (SC-021).
 *
 * `reconstructLaunchConfiguration` is exported beside the two readers because the rule it encodes —
 * which field comes from the pinned version and which from the mutable current row — is the whole
 * requirement, and it is assertable without a database.
 */
export {
  loadLaunchConfiguration,
  readLaunchConfiguration,
  reconstructLaunchConfiguration,
} from './launch-configuration'
export type {
  LaunchConfiguration,
  LaunchConfigurationReader,
  LaunchConfigurationRows,
  LiveDisplayNames,
  LiveProfileRow,
  PinnedLaunchValues,
  PinnedProfileVersionRow,
  PinnedWorkspaceVersionRow,
} from './launch-configuration'

export { lockedFieldError, OVERRIDABLE_FIELDS, resolveLaunchPlan } from './launch-plan'
export type { AppliedOverride, LaunchPlan, OverridableField } from './launch-plan'

export {
  countVisibleWorkflows,
  listWorkflows,
  readArtifacts,
  readLogSegments,
  readTimeline,
  readWorkflowDetail,
  summariseSpend,
} from './queries'
export type {
  SpendGroup,
  SpendSummary,
  TimelineEntry,
  WorkflowDetail,
  WorkflowListing,
} from './queries'

export { isWaitingOnStorage, readStoragePark } from './storage-park'
export type { StoragePark } from './storage-park'

/**
 * Attributed spend (FR-156, SC-051).
 *
 * A layer over `./queries`'s `summariseSpend` rather than a second aggregate: what FR-156 adds is
 * *who may see which rows* of an existing total, and computing that from a fresh query would give
 * the platform two answers to one question. `spendAttributionProcedure` is mounted on the router;
 * `attributeSpend` is exported beside it so the entitlement rule is assertable without one.
 */
export {
  attributeSpend,
  COLLECTIVE_SPEND_GROUPINGS,
  defaultSpendGrouping,
  INDIVIDUAL_SPEND_GROUPING,
  isIndividualGrouping,
  spendAttributionProcedure,
} from './spend'
export type { AttributedSpend, SpendGrouping } from './spend'

/**
 * Which skills a finished run resolved, and which it could not (FR-059, SC-016).
 *
 * The reads are exported alongside the procedure because "was this run explicable?" is a question
 * asked of stored rows as often as it is asked over tRPC.
 */
/** The passes of an autonomous run — scoped for a person, unlike the machine surface's history. */
export { readIterations } from './iterations'
export type { IterationPass } from './iterations'

export {
  isResolvedSkill,
  readSkillReferences,
  skillReferencesProcedure,
  summariseSkillReferences,
} from './skills'
export type { SkillReferenceReadout, SkillReferenceSummary } from './skills'

export {
  assemblePrompt,
  loadLaunchableProfileVersion,
  mayLaunchOnProfile,
  profileNotAvailableError,
  profileNotLaunchableError,
  readQueuePosition,
  readWorkspaceBranchPairs,
  resolveResumeSnapshot,
  snapshotExpiredError,
  startWorkflow,
} from './start'
export type { LaunchWriter, StartedWorkflow, StartWorkflowOptions } from './start'

export { ownerNotAvailableError, resolveOwner, startAdHocWorkflow } from './start-ad-hoc'
export type { StartAdHocOptions, StartedAdHocWorkflow } from './start-ad-hoc'

export { duplicateProfileNameError, saveConfigurationAsProfile } from './save-as-profile'
export type { ProfileWriter, SavedProfile } from './save-as-profile'

export { workflowRouter } from './router'
export type { WorkflowRouter } from './router'

export {
  findActiveUserByEmail,
  findIntegrationDefaultOwner,
  integrationOwnerlessError,
  isOwnableUser,
  OWNER_REASSIGNED_ACTION,
  reassignWorkflowOwner,
  resolveWorkflowOwner,
  unattributableWorkflowError,
  WORKFLOW_AUDIT_ENTITY_TYPE,
} from './ownership'
export type {
  OwnerReassignment,
  OwnerResolutionRequest,
  OwnershipReader,
  OwnershipWriter,
  OwnerSource,
  ReassignOwnerRequest,
  ResolvedWorkflowOwner,
} from './ownership'

export {
  assertOverridesPermitted,
  describeOverridableFields,
  lockedOverrideFields,
  lockedOverridesError,
  readProfileOverrides,
  readProfileOverridesInScope,
} from './overrides'
export type { OverridableFieldDescription, OverrideReader, RecordedOverride } from './overrides'

/**
 * The settings screen's read (FR-138, FR-140).
 *
 * Exported beside the preference readers because "can a notification reach this person at all?" is
 * asked of stored rows as often as it is asked over tRPC — and because the FR-140 unnotifiable rule
 * is worth being able to assert without mounting a router.
 */
export { readNotificationSettings } from './notification-settings'
export type { NotificationSettings, NotificationSettingsReader } from './notification-settings'

export {
  applyPreferenceDefaults,
  isWatching,
  readNotificationPreferences,
  readStoredPreferences,
  setNotificationPreference,
  unwatchWorkflow,
  watchWorkflow,
} from './watch'
export type {
  EffectiveNotificationPreference,
  WatchRequest,
  WatchResult,
  WatchWriter,
} from './watch'

export {
  acknowledgeCommandProcedure,
  pauseProcedure,
  pullPendingCommandsProcedure,
  resumeProcedure,
  stopProcedure,
} from './supervision'

export {
  acknowledgeCorrectionProcedure,
  correctionsProcedure,
  correctProcedure,
  pullPendingCorrectionsProcedure,
} from './corrections'

/**
 * The successor pair (FR-149..FR-152).
 *
 * `snapshotExpiredError` is deliberately **not** re-exported from here. `./start` already exports a
 * function of that name for restoring a stored session into a new run, and `./successor` has its own
 * for continuing one — two different sentences about two different operations. Re-exporting both
 * through one barrel is not possible, and renaming either at the barrel would give a consumer a name
 * that appears nowhere in the module it comes from. Import the module's own if you need to compare
 * against the exact message.
 */
export {
  chainProcedure,
  changedFields,
  CONTINUABLE_FIELDS,
  continueWithChanges,
  continueWithChangesProcedure,
  noChangeRequestedError,
  noInheritableSnapshotError,
  readSuccessorChain,
  readWorkflowBranchPairs,
  resolveInheritedSnapshot,
} from './successor'
export type {
  ChainLink,
  ContinuableField,
  ContinueWithChangesOptions,
  InheritedSnapshot,
  SuccessorChain,
  SuccessorWorkflow,
  SuccessorWriter,
} from './successor'

/**
 * The cross-repository concurrency guard (FR-120).
 *
 * A guard rather than a procedure: nothing *mounts* it, because what it protects is the launch
 * path — two runs must not hold the same `(repository_url, base_branch)` pair concurrently — and
 * that is a property of writing a run's entries, not a call anybody makes. Both writers of
 * `workflow_entries` on this surface now take it: `startWorkflow` and `continueWithChanges` run
 * their whole transaction inside `withBranchLocks`. It stays exported so the deadlock and
 * serialisation properties are assertable against a real Postgres from outside the module.
 */
export {
  acquireBranchLocks,
  BRANCH_LOCK_NAMESPACE,
  branchHeldError,
  branchLockKey,
  branchLockPairs,
  findBranchHolders,
  withBranchLocks,
} from './branch-lock'
export type {
  BranchHolder,
  BranchLockOptions,
  BranchLockPair,
  BranchLockTransaction,
  BranchLockWriter,
} from './branch-lock'
