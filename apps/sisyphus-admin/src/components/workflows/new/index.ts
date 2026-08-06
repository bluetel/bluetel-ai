/**
 * The launch screen — profile-first, with the ad hoc path behind it (T064a, T080, FR-016, FR-122,
 * FR-129, FR-187).
 *
 * Nothing here is a primitive. The panel has exactly one primitive set, in `src/components/ui`,
 * and everything below composes it — including `LaunchSelect` and `PromptField`, which fill the
 * two gaps in that set (a picker and a multi-line control) by composing `fieldControlVariants`
 * rather than by restating its classes. Both are now consumed by a second screen — the workspace
 * and profile admin surface — so both have earned their place in `src/components/ui` as `Select`
 * and `TextArea`, and that promotion is the next edit rather than a third copy.
 *
 * Consumers import this barrel, never a module inside it.
 */

export { AdHocLaunchForm } from './ad-hoc-launch-form'

export { JobSpecFields } from './job-spec-fields'

export {
  EMPTY_LAUNCH_FORM,
  fieldForIssuePath,
  launchFieldAction,
  toStartAdHocInput,
} from './launch-form-values'
export type {
  LaunchFieldErrors,
  LaunchFieldName,
  LaunchFormValues,
  LaunchSubmission,
  StartAdHocValues,
} from './launch-form-values'

export {
  describeLaunch,
  describeLaunchError,
  describeProfileCatalogueError,
  describeProfileLaunch,
  describeProfileLaunchError,
  PROFILE_CATALOGUE_UNAVAILABLE,
} from './launch-outcome'
export type { AdHocLaunchResult, LaunchNotice, ProfileLaunchResult } from './launch-outcome'

export { LaunchPanel } from './launch-panel'

export { LaunchSelect } from './launch-select'
export type { LaunchOption } from './launch-select'

export { LockedValue } from './locked-value'

export { ProfileLaunchFields } from './profile-launch-fields'
export { ProfileLaunchForm } from './profile-launch-form'

export { profileFieldCode, profileFieldError, toStartWorkflowInput } from './profile-launch-values'
export type {
  ProfileLaunchErrors,
  ProfileLaunchExtras,
  ProfileLaunchFieldName,
  ProfileLaunchSubmission,
  StartWorkflowValues,
} from './profile-launch-values'

export {
  describeLaunchFieldLocks,
  LOCKABLE_FIELD_CONTROLS,
  LOCKABLE_FIELD_NAMES,
  lockedFieldCode,
  lockedFieldRefusals,
  lockedLaunchControls,
} from './profile-locks'
export type { LaunchFieldLock } from './profile-locks'

export {
  ABSENT_PROFILE_VALUE,
  findLaunchProfile,
  launchableProfiles,
  prefillFromProfile,
  profileLaunchOptions,
  profileVersionReadouts,
} from './profile-prefill'
export type { LaunchProfile, LaunchProfileVersion, ProfileVersionReadout } from './profile-prefill'

export { PromptField } from './prompt-field'

export { WorkspaceSourceFields } from './workspace-source-fields'
