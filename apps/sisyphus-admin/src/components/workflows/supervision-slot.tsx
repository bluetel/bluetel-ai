import { Card, CardBody, CardHeader, StateChip } from '@sisyphus-admin/components/ui'
import type { ReactNode } from 'react'

/**
 * **The named slot the supervision controls mount into (Phase 7, FR-015, FR-049, SC-003).**
 *
 * Pause, resume, stop and mid-run correction are not built here and must not be. Each is a
 * mutation that serialises on the workflow row so two corrections are delivered exactly once in
 * submission order, and the panel may only report "paused" once the executor has **acknowledged**
 * the command — otherwise the UI claims a pause the instance has not performed. That is a
 * behaviour with a protocol behind it, not a row of buttons, and building it early would mean
 * building the wrong half of it.
 *
 * So the slot states what is absent rather than showing disabled controls. A greyed-out Pause
 * button implies the capability exists and is momentarily unavailable, which is a different and
 * false claim: what is true today is that this panel cannot supervise a run at all.
 *
 * When Phase 7 lands, the detail panel passes the controls as `children` and nothing else here
 * changes.
 */
interface SupervisionSlotProps {
  /** The run these controls would act on. */
  readonly workflowId: string
  /** Whether the run is in a state supervision could act on at all. */
  readonly live: boolean
  /** The supervision controls, once they exist. Absent until then. */
  readonly children?: ReactNode
}

export const SupervisionSlot = ({ workflowId, live, children }: SupervisionSlotProps) => (
  <Card aria-label="Supervision">
    <CardHeader>
      <span>supervision</span>
      <StateChip>{children === undefined ? 'not mounted' : 'mounted'}</StateChip>
    </CardHeader>
    <CardBody>
      {children ?? (
        <p className="type-body text-graphite measure-prose">
          {live
            ? 'Pause, resume, stop and mid-run correction are not mounted on this page yet. This run is still in flight, so there is nothing here you could use on it.'
            : 'Pause, resume, stop and mid-run correction are not mounted on this page yet. This run has finished, so there would be nothing to act on either way.'}{' '}
          <span className="type-data-mono">{workflowId}</span>
        </p>
      )}
    </CardBody>
  </Card>
)
