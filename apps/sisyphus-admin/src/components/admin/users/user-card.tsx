'use client'

import { ChangeNotice } from '@sisyphus-admin/components/admin/change-notice'
import { DataReadout } from '@sisyphus-admin/components/admin/data-readout'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import { Button, Card, CardBody, CardHeader, StateChip } from '@sisyphus-admin/components/ui'

import { UserActionForm } from './user-action-form'
import type { UserActionKind } from './user-actions'
import { availableUserActions } from './user-actions'
import type { UserChangeNotice } from './user-change-outcome'
import type { AdministeredUser } from './user-listing'
import { toUserReadouts } from './user-listing'

interface UserCardProps {
  user: AdministeredUser
  /** The change awaiting confirmation on this row, if any. */
  selected?: UserActionKind
  reason: string
  /** `Date.now()` when the mutation started, or `undefined` when nothing is in flight. */
  startedAt?: number
  error?: FieldErrorContent
  notice?: UserChangeNotice
  onSelect: (kind: UserActionKind) => void
  onCancel: () => void
  onReasonChange: (reason: string) => void
  onConfirm: (kind: UserActionKind) => void
}

/**
 * One user, with everything FR-171 asks for and the two changes FR-172 allows.
 *
 * The reassignment backlog sits next to the identity rather than in a column further right,
 * because it is the fact that decides whether a deactivation is safe — and a fact an operator has
 * to scroll to is a fact they will not read (FR-176).
 *
 * The chips are the idle graphite ones. Role and activity are not `workflow_state`, and the three
 * state colours are locked to machine state — an `inactive` chip in `rust` would be exactly the
 * decorative use of a state colour the system forbids.
 */
export const UserCard = ({
  user,
  selected,
  reason,
  startedAt,
  error,
  notice,
  onSelect,
  onCancel,
  onReasonChange,
  onConfirm,
}: UserCardProps) => {
  const readouts = toUserReadouts(user)
  const actions = availableUserActions(user)
  const selectedAction = actions.find((action) => action.kind === selected)

  return (
    <Card>
      <CardHeader>
        <span>{readouts.email}</span>
        <span className="gap-tight flex items-center">
          <StateChip>{readouts.role}</StateChip>
          <StateChip>{readouts.activity}</StateChip>
        </span>
      </CardHeader>

      <CardBody className="gap-default flex flex-col">
        <p className="type-body text-ink">{readouts.displayName}</p>

        <div className="gap-default flex flex-wrap">
          <DataReadout label="last sign-in" value={readouts.lastSignIn} />
          <DataReadout label="owns runs" value={readouts.ownedRuns} />
          {readouts.awaitingReassignment === undefined ? null : (
            <DataReadout label="awaiting reassignment" value={readouts.awaitingReassignment} />
          )}
        </div>

        {notice === undefined ? null : (
          <ChangeNotice readout={notice.readout} detail={notice.detail} />
        )}

        {selectedAction === undefined ? (
          <div className="gap-tight flex flex-wrap">
            {actions.map((action) => (
              <Button
                key={action.kind}
                variant={action.variant}
                onClick={() => {
                  onSelect(action.kind)
                }}
              >
                {action.label}
              </Button>
            ))}
          </div>
        ) : (
          <UserActionForm
            action={selectedAction}
            reason={reason}
            startedAt={startedAt}
            error={error}
            onReasonChange={onReasonChange}
            onCancel={onCancel}
            onConfirm={() => {
              onConfirm(selectedAction.kind)
            }}
          />
        )}
      </CardBody>
    </Card>
  )
}
