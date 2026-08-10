/**
 * Credential groups: the pools agent credentials belong to, and the ordered attachments that decide
 * which execution profiles may draw on them (T026, T027, US2, FR-060..FR-067).
 *
 * Two screens ship from here, and they are two screens for a reason:
 *
 * - {@link CredentialGroupsPanel} manages the groups themselves — creating, renaming, disabling, and
 *   FR-066's refusal to delete one that is in use, stated as the two named conditions it actually
 *   is rather than as "in use".
 * - {@link ProfileCredentialGroupsPanel} manages one profile's **ordered** attachments, and carries
 *   FR-065's unlaunchable verdict inline, from the moment the list is read, rather than waiting for
 *   a save to bounce.
 *
 * Nothing here is a primitive — the panel has exactly one primitive set, in `src/components/ui`.
 * Consumers import this barrel, never a module inside it.
 */

export {
  ATTACHMENT_GATE_REASONS,
  describeUsableAttachments,
  evaluateAttachmentGate,
  usableAttachments,
} from './attachment-gate'
export type { AttachmentGateFailure, AttachmentGateReason } from './attachment-gate'

export { AttachmentGateNotice } from './attachment-gate-notice'

export {
  attachmentOrderIds,
  canMoveAttachment,
  moveAttachment,
  ordinal,
  preferenceReadout,
} from './attachment-order'
export type { AttachmentMove, ProfileAttachment } from './attachment-order'

export {
  describeAttached,
  describeAttachmentError,
  describeDetached,
  describeOrder,
  describeReordered,
} from './attachment-outcome'
export type { AttachmentNotice, ProfileAttachmentsResult } from './attachment-outcome'

export { AttachmentRow } from './attachment-row'

export { CreateGroupForm } from './create-group-form'

export { CredentialGroupsPanel } from './credential-groups-panel'

export {
  classifyDeletionCondition,
  DELETION_ACTIONS,
  DELETION_CONDITIONS,
  deletionConditionCode,
  describeDeletionRefusal,
  DISABLE_ALTERNATIVE,
  readDeletionConditions,
} from './deletion-refusal'
export type {
  DeletionCondition,
  DeletionConditionNotice,
  DeletionRefusal,
} from './deletion-refusal'

export { CredentialGroupCard } from './group-card'
export type { CredentialGroupRenameDraft } from './group-card'

export {
  ABSENT,
  deletionBlockersFromCounts,
  describeDeletionBlocker,
  toCredentialGroupReadouts,
} from './group-listing'
export type { CredentialGroupListItem, CredentialGroupReadouts } from './group-listing'

export {
  describeCredentialGroupCreated,
  describeCredentialGroupDeleted,
  describeCredentialGroupEnable,
  describeCredentialGroupError,
  describeCredentialGroupRenamed,
} from './group-outcome'
export type {
  CredentialGroupEnableResult,
  CredentialGroupNotice,
  CredentialGroupResult,
} from './group-outcome'

export { ProfileCredentialGroupsPanel } from './profile-credential-groups-panel'
