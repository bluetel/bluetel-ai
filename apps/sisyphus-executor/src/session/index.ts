/**
 * The session surface — suspending a run, snapshotting it, and restoring it somewhere else
 * (T091, T092, T097, T098, T100).
 *
 * Consumers import this barrel, never a module underneath it.
 */

export {
  discoverSessionIds,
  mangleWorkspacePath,
  parseConversationLog,
  sessionLogDirectory,
} from './conversation-log'
export type { ConversationLog } from './conversation-log'

export {
  createQuietMetadataReader,
  DEFAULT_INTERRUPTION_POLL_MS,
  watchForInterruption,
} from './interruption'
export type {
  InstanceMetadataReader,
  InterruptionNotice,
  InterruptionWatchOptions,
  InterruptionWatchResult,
  InterruptionWatchStop,
} from './interruption'

export {
  DEFAULT_PARK_BUDGET,
  parkAndRetry,
  parkDelayMs,
  SnapshotBoundaryUnpersistedError,
} from './park'
export type { ParkBudget, ParkOptions, ParkReport, SnapshotBoundary } from './park'

export {
  restoreSession,
  SnapshotIncompleteError,
  SnapshotUnavailableError,
  verifyRestoredWorkspace,
} from './restore'
export type {
  RestoredSession,
  RestoredWorkspace,
  RestoreOptions,
  SnapshotReference,
} from './restore'

export {
  CONVERSATION_SUBTREE,
  containsCredentialMaterial,
  CREDENTIAL_SUBTREE,
  createSnapshotWriter,
  snapshotExcludePatterns,
  snapshotObjectKey,
  snapshotStateFlags,
} from './snapshot'
export type { SnapshotStateFlags, SnapshotWriterOptions } from './snapshot'

export {
  archiveAnchorDirectory,
  archiveMemberName,
  listArchiveMembers,
  packWorkspaceArchive,
  SnapshotArchiveError,
  unpackWorkspaceArchive,
} from './snapshot-archive'
export type { PackArchiveOptions, PackedArchive, UnpackArchiveOptions } from './snapshot-archive'

export {
  codedError,
  createFakeSnapshotStore,
  isCodedError,
  SNAPSHOT_NOT_FOUND,
  SNAPSHOT_STORE_UNREACHABLE,
} from './snapshot-store'
export type {
  CodedError,
  FakeSnapshotStore,
  SnapshotLocation,
  SnapshotObjectStore,
} from './snapshot-store'

export { runRestoreSpike } from './spike-restore'
export type { RestoreSpikeOptions, RestoreSpikeOutcome } from './spike-restore'

export { suspend, suspensionPlanFor } from './suspend'
export type {
  CapturedSnapshot,
  ComputeRelease,
  SnapshotPort,
  SnapshotRegistration,
  SnapshotRequest,
  SuspendAgentPort,
  SuspendOptions,
  SuspendReason,
  SuspendResult,
  SuspensionPlan,
} from './suspend'
