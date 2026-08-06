'use client'

import { ElapsedReadout } from '@sisyphus-admin/components/admin/elapsed-readout'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import { Button, Field } from '@sisyphus-admin/components/ui'

import type { UserAction } from './user-actions'

interface UserActionFormProps {
  action: UserAction
  /** The optional reason recorded alongside the change in the append-only history (FR-177). */
  reason: string
  onReasonChange: (reason: string) => void
  onConfirm: () => void
  onCancel: () => void
  /** `Date.now()` when the mutation started, or `undefined` when it is not in flight. */
  startedAt?: number
  /** The refusal, if the server refused. Carries a machine code and a next action. */
  error?: FieldErrorContent
}

/**
 * Confirming one change to one user, with the reason that goes into the history.
 *
 * **The refusal is a field error, not a toast.** A never-zero-admins refusal (FR-173) arrives here
 * attached to the reason field, so it sits under the control the operator was using, carries
 * `E_LAST_ACTIVE_ADMIN` and says what to do next. A toast would drift away from the row it belongs
 * to, would not be re-readable, and would leave a screen reader user with no association between
 * the message and the form.
 *
 * The consequence is stated **above** the confirm button rather than after the change, because a
 * consequence read afterwards is a report, not a decision.
 */
export const UserActionForm = ({
  action,
  reason,
  onReasonChange,
  onConfirm,
  onCancel,
  startedAt,
  error,
}: UserActionFormProps) => {
  const pending = startedAt !== undefined

  return (
    <div className="gap-close border-hairline p-close flex flex-col rounded-sm border">
      <p className="type-body text-ink measure-prose">{action.consequence}</p>

      <Field
        label="Reason (optional)"
        name="reason"
        value={reason}
        error={error}
        disabled={pending}
        onChange={(event) => {
          onReasonChange(event.target.value)
        }}
      />

      <div className="gap-tight flex flex-wrap items-center">
        {pending ? (
          <Button
            variant={action.variant}
            pending
            readout={<ElapsedReadout verb={action.verb} startedAt={startedAt} />}
          />
        ) : (
          <Button variant={action.variant} onClick={onConfirm}>
            {`Confirm: ${action.label.toLowerCase()}`}
          </Button>
        )}
        <Button variant="quiet" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
