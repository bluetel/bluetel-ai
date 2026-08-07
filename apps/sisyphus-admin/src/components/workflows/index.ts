/**
 * The fleet list and the run detail view (T076, FR-012, FR-013, FR-014, FR-190).
 *
 * Nothing here is a primitive — the panel has exactly one primitive set, in `src/components/ui`,
 * and everything below composes it. What lives here is the workflow surface: how a run reads as a
 * row, how the list's filters travel between a URL, a form and a procedure's input, and what the
 * detail view shows around its two named slots — which since T207 and T208 hold the log viewer
 * (`components/log-viewer`) and the supervision controls (`components/supervision`) rather than a
 * statement of their absence.
 *
 * Consumers import this barrel, never a module inside it.
 */

export { EntryResultsCard, toEntryResultsReadouts } from './entry-results'
export type {
  EntryOutcomeReadouts,
  EntryResultsReadouts,
  EntryStanding,
  EntryStandingCounts,
} from './entry-results'

/**
 * The autonomous loop's iteration record. Rendered only for runs that have passes — a delegated run
 * has none, and a card reading "0 of 3" would invent a loop that never applied to it.
 */
export { IterationTimelineCard, toIterationRecords } from './iterations'
export type {
  FindingReadouts,
  IterationPass,
  IterationReadouts,
  IterationRecord,
  IterationTimelineReadouts,
  IterationVerdict,
} from './iterations'

export { LogViewerSlot } from './log-viewer-slot'
export { SupervisionSlot } from './supervision-slot'

/**
 * The page's one clock.
 *
 * On the barrel because a live duration is not a workflow-directory private: `components/admin/fleet`
 * renders the same rows against the same clock, and the two ways of giving it one were a second
 * `useNow` — two intervals, two timestamps, and durations on one screen disagreeing with each other
 * by a second — or an import that reached past this file. Neither is better than exporting it.
 *
 * `NOW_TICK_MS` comes with it so a consumer that wants a slower page can say so in the units the
 * hook is written in rather than in a number of its own.
 */
export { NOW_TICK_MS, useNow } from './use-now'

/**
 * Watching a run you do not own (T160, FR-138, FR-190).
 *
 * The refusal mapping is published alongside the control because it is the security property, not a
 * detail of it: `describeWatchError` answers identically for `NOT_FOUND` and `FORBIDDEN`, so the
 * panel cannot be used to tell an out-of-scope run from one that does not exist.
 */
export {
  describeWatchError,
  describeWatchOutcome,
  WATCH_REFUSED,
  WatchToggle,
} from './watch-toggle'
export type { WatchNotice, WatchResult } from './watch-toggle'

export { formatRetryDelay, toStorageParkReadout } from './storage-park'
export type { StorageParkReadout, StorageParkResult } from './storage-park'

export { WorkflowArtifactsCard } from './workflow-artifacts-card'
export { WorkflowDetailPanel } from './workflow-detail-panel'

export {
  toArtifactReadouts,
  toTimelineReadouts,
  toWorkflowDetailReadouts,
  toWorkflowEntryReadouts,
} from './workflow-detail-readouts'
export type {
  ArtifactItem,
  ArtifactReadouts,
  CapReadout,
  TimelineItem,
  TimelineReadouts,
  WorkflowDetailReadouts,
  WorkflowDetailResult,
  WorkflowEntryReadouts,
} from './workflow-detail-readouts'

export { WorkflowEntriesCard } from './workflow-entries-card'
export { WorkflowFilterBar } from './workflow-filter-bar'

export {
  EMPTY_FILTERS,
  hasActiveFilters,
  ID_FILTER_KEYS,
  ID_FILTER_NAMES,
  invalidIdFilters,
  parseWorkflowFilters,
  toListInput,
  toSearchParams,
  WORKFLOW_PAGE_SIZE,
} from './workflow-filters'
export type { ListWorkflowsInput, WorkflowFilters } from './workflow-filters'

export { WorkflowList } from './workflow-list'

export {
  ABSENT,
  abbreviateRunId,
  isLiveWorkflow,
  toWorkflowRowReadouts,
  workflowDuration,
  workflowStateReadout,
} from './workflow-listing'
export type { WorkflowListItem, WorkflowRowReadouts } from './workflow-listing'

export { WorkflowRow } from './workflow-row'
export { WorkflowSummaryCard } from './workflow-summary-card'
export { WorkflowTimeline } from './workflow-timeline'
export { WorkflowsPanel } from './workflows-panel'
