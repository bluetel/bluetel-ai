'use client'

import { describeTrpcError, isNotFoundError, NotFoundCard } from '@sisyphus-admin/components/admin'
import { LogViewer } from '@sisyphus-admin/components/log-viewer'
import { supervisionStatus, WorkflowSupervision } from '@sisyphus-admin/components/supervision'
import {
  Card,
  CardBody,
  CardHeader,
  FieldError,
  LoadingState,
  StateChip,
} from '@sisyphus-admin/components/ui'
import { api } from '@sisyphus-admin/trpc'

import { EntryResultsCard, toEntryResultsReadouts } from './entry-results'
import {
  IterationTimelineCard,
  toIterationRecords,
  toIterationTimelineReadouts,
} from './iterations'
import { LogViewerSlot } from './log-viewer-slot'
import { SupervisionSlot } from './supervision-slot'
import { useNow } from './use-now'
import { WatchToggle } from './watch-toggle'
import { WorkflowArtifactsCard } from './workflow-artifacts-card'
import {
  toArtifactReadouts,
  toTimelineReadouts,
  toWorkflowDetailReadouts,
  toWorkflowEntryReadouts,
} from './workflow-detail-readouts'
import { WorkflowEntriesCard } from './workflow-entries-card'
import { isLiveWorkflow } from './workflow-listing'
import { WorkflowSummaryCard } from './workflow-summary-card'
import { WorkflowTimeline } from './workflow-timeline'

/**
 * The workflow detail view (T076, FR-014, FR-190).
 *
 * ## FR-190 applies to this component, not only to the router
 *
 * The run id arrives in the URL, which means it is the caller's guess. `workflow.byId` answers
 * `NOT_FOUND` for a run that does not exist **and** for one outside the caller's scope, with the
 * same code and the same message, so the two cannot be told apart. This panel renders that as
 * {@link NotFoundCard} and nothing else. A "you do not have permission to view this run" screen
 * would hand back precisely the disclosure the error code was chosen to prevent — the server would
 * have been careful and the UI would have told them anyway.
 *
 * The same rule is why the three queries are not gated on one another's success in a way that
 * would leak: `timeline` and `artifacts` go through the same scope check and answer `NOT_FOUND`
 * identically, so a caller who cannot see the run cannot see one byte of its log or one row of its
 * artifacts, and cannot tell whether it exists.
 *
 * ## The watch control is mounted from the *resolved* run, not from the URL
 *
 * `WatchToggle` is passed `detail.data.workflow.id` — the id the server returned — and is rendered
 * only inside the branch where that exists. `workflowId`, the caller's guess from the URL, is
 * deliberately not used for it. `watch` and `unwatch` are scoped and refuse an out-of-scope run
 * with the same `NOT_FOUND` a nonexistent one gets, and this is what stops the panel undoing that
 * from the outside: for a run the caller may not see there is no id to hand the control, so there
 * is no control to press and no refusal to read a fact out of (FR-138, FR-190). Rendering it
 * eagerly beside the not-found card, or while the read was still in flight, would turn a button
 * into a lookup anyone could run over the whole id space.
 *
 * ## The two slots, now filled (T207, T208)
 *
 * `LogViewerSlot` and `SupervisionSlot` are where the log viewer and the supervision controls
 * mount, and each now receives the real component as `children`. Neither slot changed to take one:
 * both were written to hold a space and hand it over, and that is all that happened.
 *
 * The two are mounted differently, and the difference is deliberate.
 *
 * - **The log viewer takes the id from the URL**, like `timeline` and `artifacts` do. Its reads are
 *   the scoped `workflow.logSegments` query and the `/api/stream/{id}` route, both of which answer
 *   a run the caller may not see with the same `404` a nonexistent one gets — so there is nothing
 *   for the panel to leak by starting them early, and starting them early is the point: SC-002 is
 *   measured in seconds, and holding the stream behind `byId` would spend them.
 * - **The supervision controls take the id `byId` returned**, like `WatchToggle` does, and are not
 *   rendered until it exists. They are four *mutations*, and a button rendered against a guessed id
 *   is a refusal an operator can read a fact out of (FR-190). They also cannot render honestly
 *   without the run's state — a card that could not say what the run is doing has no business
 *   offering to pause it — so until the read lands the slot holds a reading state instead.
 *
 * ## Why the run is re-read on a cadence
 *
 * `workflow.byId` polls while the run is unfinished. FR-015 requires the panel to reflect a
 * transition without a manual reload, and FR-049 means the *only* honest source for "paused" is the
 * state the executor's acknowledgement wrote — a pause mutation resolving proves a queue row was
 * written and nothing else. Without the poll the card would say "pause requested" until somebody
 * pressed refresh. A finished run is re-read no further: nothing about it will change again.
 */
interface WorkflowDetailPanelProps {
  readonly workflowId: string
}

/**
 * How often an unfinished run is re-read.
 *
 * Short enough that an acknowledged pause appears well inside SC-003's ten seconds, long enough
 * that a detail view left open all afternoon is not a load test.
 */
export const WORKFLOW_DETAIL_POLL_MS = 5_000

export const WorkflowDetailPanel = ({ workflowId }: WorkflowDetailPanelProps) => {
  const detail = api.workflow.byId.useQuery(
    { workflowId },
    {
      refetchInterval: (query) => {
        const state = query.state.data?.workflow.state

        return state !== undefined && supervisionStatus({ workflowState: state }) === 'finished'
          ? false
          : WORKFLOW_DETAIL_POLL_MS
      },
    },
  )
  const timeline = api.workflow.timeline.useQuery({ workflowId })
  const artifacts = api.workflow.artifacts.useQuery({ workflowId })
  const iterations = api.workflow.iterations.useQuery({ workflowId })
  // One clock for the page, so the summary's duration and its chip's readout agree. Read before
  // the not-found branch, because a hook after an early return is a hook that sometimes runs.
  const now = useNow()

  if (isNotFoundError(detail.error)) {
    return <NotFoundCard message="No such run." />
  }

  const readouts =
    detail.data === undefined ? undefined : toWorkflowDetailReadouts(detail.data, now)
  const entries = detail.data === undefined ? [] : toWorkflowEntryReadouts(detail.data)
  // Rendered only once the run has been read, rather than in a reading state, because the whole
  // point of this card is a claim about the set — "2 of 3 landed" — and a card that appeared saying
  // nothing would read as "nothing to report" for exactly as long as the query took (FR-118).
  const entryResults = detail.data === undefined ? undefined : toEntryResultsReadouts(detail.data)
  // Absent for a delegated run, which has no iterations at all — the card is not rendered rather
  // than rendered empty, because "0 of 3" would describe a loop this run was never in (FR-061).
  const iterationTimeline =
    iterations.data === undefined || iterations.data.length === 0
      ? undefined
      : toIterationTimelineReadouts(toIterationRecords(iterations.data))

  return (
    <div className="gap-section flex flex-col">
      {detail.error !== null && !isNotFoundError(detail.error) ? (
        <FieldError {...describeTrpcError(detail.error)} />
      ) : null}

      {readouts === undefined ? (
        <Card aria-label="Run">
          <CardHeader>
            <span>run</span>
            <StateChip>reading</StateChip>
          </CardHeader>
          <CardBody>
            <LoadingState>reading this run</LoadingState>
          </CardBody>
        </Card>
      ) : (
        <WorkflowSummaryCard detail={readouts} />
      )}

      {readouts?.reviewerSummary === null || readouts === undefined ? null : (
        <Card aria-label="Reviewer summary">
          <CardHeader>
            <span>reviewer summary</span>
          </CardHeader>
          <CardBody>
            <p className="type-body text-ink measure-prose">{readouts.reviewerSummary}</p>
          </CardBody>
        </Card>
      )}

      {detail.data === undefined ? null : <WatchToggle workflowId={detail.data.workflow.id} />}

      <SupervisionSlot
        workflowId={workflowId}
        live={readouts === undefined ? false : isLiveWorkflow(readouts.state)}
      >
        {detail.data === undefined ? (
          <LoadingState>reading this run</LoadingState>
        ) : (
          <WorkflowSupervision
            workflowId={detail.data.workflow.id}
            workflowState={detail.data.workflow.state}
          />
        )}
      </SupervisionSlot>

      <LogViewerSlot workflowId={workflowId}>
        <LogViewer workflowId={workflowId} />
      </LogViewerSlot>

      {entryResults === undefined ? null : <EntryResultsCard results={entryResults} />}

      <WorkflowEntriesCard entries={entries} loading={detail.isPending} />

      {iterationTimeline === undefined ? null : (
        <IterationTimelineCard timeline={iterationTimeline} loading={iterations.isPending} />
      )}

      <WorkflowTimeline
        entries={toTimelineReadouts(timeline.data ?? [])}
        loading={timeline.isPending}
      />

      <WorkflowArtifactsCard
        artifacts={toArtifactReadouts(artifacts.data ?? [], now)}
        loading={artifacts.isPending}
      />
    </div>
  )
}
