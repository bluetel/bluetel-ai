'use client'

import { ElapsedReadout } from '@sisyphus-admin/components/admin/elapsed-readout'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import { Button, FieldError } from '@sisyphus-admin/components/ui'

import { describeRevocationCascade } from './revocation-outcome'

interface RevokeConfirmationProps {
  /** Who holds the grant, so the cascade names a person. */
  holder: string
  onConfirm: () => void
  onCancel: () => void
  /** `Date.now()` when the revocation started, or `undefined` while the admin is still deciding. */
  startedAt?: number
  error?: FieldErrorContent
}

/**
 * What revoking this grant will do, said before it is done (FR-188).
 *
 * The cascade list is the whole point of this component. Revocation removes workflow watches the
 * grant was keeping alive, and an admin who learns that afterwards has already broken someone's
 * subscription. So the consequences are enumerated here, above the confirm control, and the
 * *count* is reported afterwards by the notice — because no procedure can truthfully predict it,
 * and a number computed a moment early is a number that can be wrong by the time it is pressed.
 *
 * The refusal renders through `FieldError` rather than a toast: there is no input to attach it to,
 * but the code-and-next-action contract is the same one, and a second error component would be a
 * duplicate of a primitive that already exists.
 */
export const RevokeConfirmation = ({
  holder,
  onConfirm,
  onCancel,
  startedAt,
  error,
}: RevokeConfirmationProps) => {
  const pending = startedAt !== undefined

  return (
    <div className="gap-close border-rust p-close flex flex-col rounded-sm border">
      <p className="type-label-mono text-graphite">what revoking does</p>

      <ul className="gap-tight measure-prose flex flex-col">
        {describeRevocationCascade(holder).map((consequence) => (
          <li key={consequence} className="type-body text-ink">
            {consequence}
          </li>
        ))}
      </ul>

      {error === undefined ? null : <FieldError code={error.code} action={error.action} />}

      <div className="gap-tight flex flex-wrap items-center">
        {pending ? (
          <Button
            variant="danger"
            pending
            readout={<ElapsedReadout verb="Revoking" startedAt={startedAt} />}
          />
        ) : (
          <Button variant="danger" onClick={onConfirm}>
            Confirm: revoke access
          </Button>
        )}
        <Button variant="quiet" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
