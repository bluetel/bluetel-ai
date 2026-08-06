/**
 * The workspace admin screen (T082, FR-109..FR-111, FR-125, FR-127, FR-128).
 *
 * Nothing here is a primitive — the panel has exactly one primitive set, in `src/components/ui`,
 * and everything below composes it. What lives here is the versioned repository set: how a version
 * reads, how an entry list becomes a request, and what a published version says afterwards.
 *
 * Consumers import this barrel, never a module inside it.
 */

export { WorkspaceCard } from './workspace-card'
export { WorkspaceEditor } from './workspace-editor'
export { WorkspaceEntryFields } from './workspace-entry-fields'

export {
  draftFromVersion,
  EMPTY_ENTRY,
  EMPTY_WORKSPACE,
  toCreateWorkspaceInput,
  toUpdateWorkspaceInput,
  withoutEntryAt,
  withPrimaryAt,
  workspaceFieldCode,
} from './workspace-entry-values'
export type {
  CreateWorkspaceValues,
  UpdateWorkspaceValues,
  WorkspaceDraft,
  WorkspaceDraftErrors,
  WorkspaceEntryDraft,
  WorkspaceSubmission,
} from './workspace-entry-values'

export {
  ABSENT,
  toWorkspaceReadouts,
  workspaceStateReadout,
  workspaceVersionReadout,
} from './workspace-listing'
export type {
  WorkspaceEntryItem,
  WorkspaceEntryReadouts,
  WorkspaceListItem,
  WorkspaceReadout,
  WorkspaceReadouts,
} from './workspace-listing'

export {
  describeWorkspaceEnable,
  describeWorkspaceError,
  describeWorkspacePublish,
} from './workspace-outcome'
export type {
  PublishedWorkspaceResult,
  WorkspaceEnableResult,
  WorkspaceNotice,
} from './workspace-outcome'

export { WorkspacesPanel } from './workspaces-panel'
