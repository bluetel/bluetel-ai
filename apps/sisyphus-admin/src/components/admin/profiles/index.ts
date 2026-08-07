/**
 * The execution-profile admin screen (T082, FR-121..FR-128).
 *
 * Nothing here is a primitive — the panel has exactly one primitive set, in `src/components/ui`,
 * and everything below composes it. What lives here is the versioned launch preset: how a version
 * reads, how a draft becomes a request, and how the FR-124 enable gate's refusal is broken back
 * into one field error per failing element rather than flattened into a sentence.
 *
 * The per-profile access screen is `src/components/admin/grants`, which this one links to.
 *
 * Consumers import this barrel, never a module inside it.
 */

export {
  classifyEnableFailure,
  describeEnableRefusal,
  ENABLE_FAILURE_ELEMENTS,
  enableFailureCode,
  readEnableFailures,
} from './enable-refusal'
export type { EnableFailureElement, EnableFailureNotice, EnableRefusal } from './enable-refusal'

export { ProfileCard } from './profile-card'
export { ProfileEditor } from './profile-editor'

export {
  draftFromProfileVersion,
  EMPTY_PROFILE,
  profileFieldCode,
  profileFieldError,
  profileFieldForIssuePath,
  toCreateProfileInput,
  toUpdateProfileInput,
  withLockedField,
} from './profile-form-values'
export type {
  CreateProfileValues,
  ProfileDraft,
  ProfileDraftErrors,
  ProfileFieldName,
  ProfileSubmission,
  ProfileUpdateSubmission,
  UpdateProfileValues,
} from './profile-form-values'

export {
  ABSENT,
  profileStateReadout,
  profileVersionReadout,
  toProfileReadouts,
} from './profile-listing'
export type { ProfileListItem, ProfileReadouts, ProfileVersionItem } from './profile-listing'

export {
  describeProfileEnable,
  describeProfileError,
  describeProfilePublish,
  describeProfileReferences,
} from './profile-outcome'
export type {
  ProfileEnableResult,
  ProfileNotice,
  ProfileReferencesResult,
  PublishedProfileResult,
} from './profile-outcome'

export { ProfilesPanel } from './profiles-panel'
