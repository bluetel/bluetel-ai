import { DataReadout } from '@sisyphus-admin/components/admin'
import { Card, CardBody, CardHeader, StateChip } from '@sisyphus-admin/components/ui'

import type { TimelineReadouts } from './workflow-detail-readouts'

/**
 * The append-only lifecycle timeline (FR-014, FR-064).
 *
 * Oldest first, because it is a narrative: a reader wants "provisioned, started, corrected, capped"
 * in that order, not reversed. The ordering is the procedure's; this component must not re-sort it,
 * because a timeline the panel reordered is no longer the record the platform wrote.
 *
 * Every line is a machine readout — the event, who caused it, when — so all three are `data-mono`
 * under `label-mono` captions. There is no prose on this card at all, which is correct: nothing
 * here was written by a person.
 */
interface WorkflowTimelineProps {
  readonly entries: readonly TimelineReadouts[]
  readonly loading?: boolean
}

export const WorkflowTimeline = ({ entries, loading = false }: WorkflowTimelineProps) => (
  <Card aria-label="Timeline">
    <CardHeader>
      <span>timeline</span>
      <StateChip>{loading ? 'reading' : `events ${String(entries.length)}`}</StateChip>
    </CardHeader>
    <CardBody className="gap-close flex flex-col">
      {loading || entries.length > 0 ? null : (
        <p className="type-data-mono text-graphite">no lifecycle events recorded yet</p>
      )}

      <ol className="gap-close flex flex-col">
        {entries.map((entry) => (
          <li key={entry.id} className="gap-default flex flex-wrap">
            <DataReadout label="event" value={entry.event} />
            <DataReadout label="actor" value={entry.actor} />
            <DataReadout label="at" value={entry.at} />
          </li>
        ))}
      </ol>
    </CardBody>
  </Card>
)
