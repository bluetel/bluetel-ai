'use client'

import { DataReadout, ElapsedReadout } from '@sisyphus-admin/components/admin'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import { Button, FieldError } from '@sisyphus-admin/components/ui'

import type { AttachmentMove, ProfileAttachment } from './attachment-order'
import { preferenceReadout } from './attachment-order'

/**
 * One attached credential group, in its place in the preference order (T027, FR-062, FR-064).
 *
 * ## The position is spelled out, not drawn
 *
 * A list with arrows beside it is an order whose meaning the reader has to already know, and the
 * two available readings — "tried first" and "most important" — are different decisions. So the row
 * carries `1st of 3 — tried first` as a readout, the controls are called **Move earlier** and
 * **Move later** rather than up and down, and the arrow that cannot do anything is disabled rather
 * than absent, so the ends of the order are visible from either end.
 *
 * ## An attached group can be present and useless
 *
 * A group that has been disabled or deleted withholds every member from selection (FR-006 applied
 * group-wide), so an attachment to one is capacity on paper and none in practice. The row says so
 * on itself, because the gate above the list can only say that *all* of them are unusable — and a
 * profile with one working group and one broken one is a configuration whose weakness is invisible
 * until the working one runs out.
 */

interface AttachmentRowProps {
  attachment: ProfileAttachment
  /** How many groups are attached, so the row can say where it sits in the whole order. */
  total: number
  onMove: (move: AttachmentMove) => void
  onDetach: () => void
  canMoveEarlier: boolean
  canMoveLater: boolean
  /** `Date.now()` while this row's own change is in flight. */
  startedAt?: number
  error?: FieldErrorContent
}

export const AttachmentRow = ({
  attachment,
  total,
  onMove,
  onDetach,
  canMoveEarlier,
  canMoveLater,
  startedAt,
  error,
}: AttachmentRowProps) => {
  const pending = startedAt !== undefined
  const usable = attachment.enabled && attachment.archivedAt === null

  return (
    <li
      data-position={attachment.position}
      className="gap-tight flex flex-col"
      aria-label={`Attached credential group ${attachment.name}`}
    >
      <div className="gap-default flex flex-wrap">
        <DataReadout label="credential group" value={attachment.name} />
        <DataReadout label="preference" value={preferenceReadout(attachment.position, total)} />
        <DataReadout
          label="state"
          value={
            attachment.archivedAt === null
              ? attachment.enabled
                ? 'enabled'
                : 'disabled'
              : 'deleted'
          }
        />
      </div>

      {usable ? null : (
        <p className="type-data-mono text-graphite">
          this group is unavailable, so no run launched from this profile can be given one of its
          credentials — selection passes over it to the next group in the order
        </p>
      )}

      {error === undefined ? null : <FieldError code={error.code} action={error.action} />}

      <div className="gap-close flex flex-wrap">
        {pending ? (
          <Button
            variant="secondary"
            pending
            readout={<ElapsedReadout verb="Working" startedAt={startedAt} />}
          />
        ) : (
          <>
            <Button
              variant="secondary"
              disabled={!canMoveEarlier}
              onClick={() => {
                onMove('earlier')
              }}
            >
              Move earlier
            </Button>
            <Button
              variant="secondary"
              disabled={!canMoveLater}
              onClick={() => {
                onMove('later')
              }}
            >
              Move later
            </Button>
            <Button variant="quiet" onClick={onDetach}>
              Detach
            </Button>
          </>
        )}
      </div>
    </li>
  )
}
