'use client'

import { describeTrpcError, isNotFoundError, NotFoundCard } from '@sisyphus-admin/components/admin'
import { Card, CardBody, CardHeader, FieldError, StateChip } from '@sisyphus-admin/components/ui'
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
 * ## The two slots
 *
 * `LogViewerSlot` and `SupervisionSlot` are where T077's log viewer and Phase 7's controls mount.
 * Neither is built here. Both render an honest "not mounted" state rather than an empty region or
 * a disabled control, for the reason stated in each.
 */
interface WorkflowDetailPanelProps {
  readonly workflowId: string
}

export const WorkflowDetailPanel = ({ workflowId }: WorkflowDetailPanelProps) => {
  const detail = api.workflow.byId.useQuery({ workflowId })
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
            <p className="type-data-mono text-graphite">reading this run</p>
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

      <SupervisionSlot
        workflowId={workflowId}
        live={readouts === undefined ? false : isLiveWorkflow(readouts.state)}
      />

      <LogViewerSlot workflowId={workflowId} />

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
