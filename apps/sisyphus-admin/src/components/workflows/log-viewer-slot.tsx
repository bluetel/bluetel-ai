import { Card, CardBody, CardHeader, StateChip } from '@sisyphus-admin/components/ui'
import type { ReactNode } from 'react'

/**
 * **The named slot the log viewer mounts into (T077, FR-046).**
 *
 * The viewer itself is not built here and must not be. It lives in
 * `src/components/log-viewer/`, it consumes the SSE stream from `/api/stream/[workflowId]`, and it
 * reconciles by `sequence` rather than by arrival time — none of which is a detail-view concern.
 * What the detail view owns is *where it goes and what stands there until it arrives*, which is
 * this component.
 *
 * A slot rather than a bare `{children}` for two reasons. It gives the viewer a card, a header and
 * a state chip so it inherits the page's structure rather than restating it; and it means the
 * placeholder is a real, honest empty state — "the log viewer is not mounted on this page yet" —
 * rather than a blank region an operator reads as a log with nothing in it. Those are very
 * different claims to make about a run.
 *
 * When T077 lands, the detail panel passes `<LogViewer workflowId={id} />` as `children` and
 * nothing else here changes.
 */
interface LogViewerSlotProps {
  /** The run whose output belongs here. Passed through so the slot can name what is missing. */
  readonly workflowId: string
  /** The log viewer, once it exists. Absent until then. */
  readonly children?: ReactNode
}

export const LogViewerSlot = ({ workflowId, children }: LogViewerSlotProps) => (
  <Card aria-label="Log">
    <CardHeader>
      <span>log</span>
      <StateChip>{children === undefined ? 'not mounted' : 'mounted'}</StateChip>
    </CardHeader>
    <CardBody>
      {children ?? (
        <p className="type-body text-graphite measure-prose">
          The log viewer is not mounted on this page yet. Nothing is being read for run{' '}
          <span className="type-data-mono">{workflowId}</span>, so an empty panel here is a missing
          component rather than a run with no output.
        </p>
      )}
    </CardBody>
  </Card>
)
