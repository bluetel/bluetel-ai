import type { WorkflowState } from '@bluetel-ai/sisyphus-api/client'
import { ACTIVE_WORKFLOW_STATES } from '@bluetel-ai/sisyphus-api/client'
import { formatElapsed, formatTimestamp } from '@sisyphus-admin/components/admin'
import type { RouterOutputs } from '@sisyphus-admin/trpc'

/**
 * Shaping one `workflow.list` row into the readouts a row renders (FR-012).
 *
 * The type comes from `RouterOutputs`, never from a hand-written DTO: a mirrored interface is
 * duplication the qlty gate flags, and it drifts silently — nothing fails when the procedure adds
 * a column and the copy does not.
 *
 * Everything a row shows is derived **here** rather than inside the JSX, because these are the
 * decisions worth asserting. A run with no initiating user rendered as an empty cell, a live run
 * whose duration froze at the last write, or an ad hoc run displayed as though it had a profile are
 * all defects a markup assertion cannot see and a table of inputs and outputs can.
 *
 * ## Why duration is computed here and not in SQL
 *
 * No `started_at`/`ended_at` pair is modelled on `workflows`: `createdAt` is when the run was
 * launched and `updatedAt` is when it last moved. So a settled run's duration is the difference
 * between the two, and a live run's is measured against now — which makes it a function of the
 * clock, which is why `now` is a parameter rather than a call to `Date.now()` inside. Deriving it
 * server-side would mean a correlated read of `workflow_events` per row, which is the per-row work
 * FR-013's responsiveness clause rules out.
 */

/** One run as `workflow.list` returns it. */
export type WorkflowListItem = RouterOutputs['workflow']['list']['items'][number]

/** What a row puts on screen. Every value is a string, because every value is a readout. */
export interface WorkflowRowReadouts {
  readonly id: string
  /** The abbreviated run id, shown in `data-mono`. The full id stays available as a title. */
  readonly runId: string
  /** The only input to the row's chip colour. Never chosen at the call site (FR-025). */
  readonly state: WorkflowState
  /** What the chip reads — `running 04:21` while a machine is working, the state alone otherwise. */
  readonly stateReadout: string
  readonly type: string
  /**
   * Who or what started it. FR-012 asks for the initiating user **or** the originating
   * integration, so the label moves with the value rather than there being two half-empty columns.
   */
  readonly startedByLabel: string
  readonly startedBy: string
  readonly owner: string
  /** The workspace, not its repositories — FR-012 says identify the set, not enumerate it. */
  readonly workspace: string
  readonly ticket: string
  readonly model: string
  readonly executionProfile: string
  readonly startedAt: string
  readonly duration: string
  readonly turns: string
  readonly spend: string
  readonly outcome: string
}

/** What an absent value reads as. An em dash, so the column keeps its shape. */
export const ABSENT = '—'

/** Whether a machine is still working on this run — the states that may still hold compute. */
export const isLiveWorkflow = (state: WorkflowState): boolean =>
  (ACTIVE_WORKFLOW_STATES as readonly string[]).includes(state)

/** How much of a run id is shown inline. Enough to tell two runs apart at a glance. */
const RUN_ID_PREVIEW_LENGTH = 8

/**
 * The leading characters of a run id, marked as abbreviated.
 *
 * The full id stays on the element's `title` and in the row's link. A truncated identifier
 * presented as if it were complete is worse than none, because it is the value an operator quotes.
 */
export const abbreviateRunId = (id: string): string =>
  id.length <= RUN_ID_PREVIEW_LENGTH ? id : `${id.slice(0, RUN_ID_PREVIEW_LENGTH)}…`

/**
 * Milliseconds a run has been going, shared by the list and the detail view.
 *
 * A settled run is measured against its last movement and stops. A live one is measured against
 * `now` — and when there is **no** clock yet, against its last movement as well, which is the
 * honest thing a render with no clock can say. See `./use-now.ts` for why the first render has
 * none.
 */
export const elapsedMs = (
  state: WorkflowState,
  createdAt: Date,
  updatedAt: Date,
  now: number | undefined,
): number =>
  (isLiveWorkflow(state) && now !== undefined ? now : updatedAt.getTime()) - createdAt.getTime()

/**
 * How long the run has been going, or how long it took.
 *
 * Reusing `formatElapsed` rather than writing a second clock keeps one definition of what `m:ss`
 * means across the console.
 */
export const workflowDuration = (item: WorkflowListItem, now: number | undefined): string =>
  formatElapsed(elapsedMs(item.state, item.createdAt, item.updatedAt, now))

/**
 * The chip's readout.
 *
 * A working run carries its elapsed time into the chip — `running 04:21` — which is the same rule
 * an in-flight button follows: the number is the information, and a lamp without one only repeats
 * what the colour already said.
 */
export const workflowStateReadout = (item: WorkflowListItem, now: number | undefined): string =>
  isLiveWorkflow(item.state)
    ? `${item.state.replace(/_/g, ' ')} ${workflowDuration(item, now)}`
    : item.state.replace(/_/g, ' ')

/**
 * Derive the readouts for one row.
 *
 * `spendUsed` is passed through exactly as the procedure returned it. It is a `numeric(12,4)`
 * carried as a decimal string precisely so it is never rounded in transit, and a currency format
 * applied here would be the panel deciding what the platform's money looks like — which belongs in
 * a token, not in a row.
 *
 * @param item - The row as `workflow.list` returned it.
 * @param now - The page's clock, so a live duration is a function of an argument rather than of
 *   `Date.now()` during render. `undefined` before the browser has one; a settled run ignores it
 *   either way.
 */
export const toWorkflowRowReadouts = (
  item: WorkflowListItem,
  now: number | undefined,
): WorkflowRowReadouts => ({
  id: item.id,
  runId: abbreviateRunId(item.id),
  state: item.state,
  stateReadout: workflowStateReadout(item, now),
  type: item.type,
  startedByLabel: item.originatingIntegrationId === null ? 'initiated by' : 'integration',
  startedBy:
    item.originatingIntegrationId === null
      ? (item.initiatedByDisplayName ?? 'platform')
      : (item.originatingIntegrationName ?? ABSENT),
  owner: item.ownerDisplayName,
  workspace: item.workspaceName,
  ticket: item.ticketReference ?? ABSENT,
  model: item.model,
  // A run launched without a profile is ad hoc, and saying so is the point: FR-126 makes the null
  // profile a fact about how the run was started, not a missing value.
  executionProfile: item.executionProfileName ?? 'ad hoc',
  startedAt: formatTimestamp(item.createdAt),
  duration: workflowDuration(item, now),
  turns: String(item.turnsUsed),
  spend: item.spendUsed,
  outcome: item.terminalOutcome ?? ABSENT,
})
