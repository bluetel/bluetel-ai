'use client'

import { ChangeNotice } from '@sisyphus-admin/components/admin/change-notice'
import { DataReadout } from '@sisyphus-admin/components/admin/data-readout'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import { Button, StateChip } from '@sisyphus-admin/components/ui'

import type { ProfileGrant } from './grant-listing'
import { isLiveGrant, toGrantReadouts } from './grant-listing'
import type { GrantNotice } from './revocation-outcome'
import { RevokeConfirmation } from './revoke-confirmation'

interface GrantRowProps {
  grant: ProfileGrant
  /** Whether this row's revocation is awaiting confirmation. */
  confirming?: boolean
  /** `Date.now()` when the revocation started, or `undefined` when nothing is in flight. */
  startedAt?: number
  error?: FieldErrorContent
  notice?: GrantNotice
  onSelect: () => void
  onCancel: () => void
  onConfirm: () => void
}

/**
 * One grant on the profile's access list (FR-179, FR-184).
 *
 * A revoked grant stays on the list — revocation writes a timestamp and never deletes — so the row
 * reports its own state and offers no control once it is spent. Re-granting is done from the issue
 * form rather than from a revoked row, because it is a new grant rather than an undo.
 *
 * The chip is the idle graphite one. `live` and `revoked` are not `workflow_state`, and colouring
 * a revoked grant `rust` would use a state colour to mean "an admin did something on purpose".
 */
export const GrantRow = ({
  grant,
  confirming = false,
  startedAt,
  error,
  notice,
  onSelect,
  onCancel,
  onConfirm,
}: GrantRowProps) => {
  const readouts = toGrantReadouts(grant)
  const live = isLiveGrant(grant)

  return (
    <li className="gap-close border-hairline p-close flex flex-col rounded-sm border">
      <div className="gap-close flex flex-wrap items-center justify-between">
        <span className="type-body text-ink">{readouts.displayName}</span>
        <StateChip>{readouts.state}</StateChip>
      </div>

      <div className="gap-default flex flex-wrap">
        <DataReadout label="address" value={readouts.email} />
        <DataReadout label="granted" value={readouts.grantedAt} />
        <DataReadout label="revoked" value={readouts.revokedAt} />
      </div>

      {notice === undefined ? null : (
        <ChangeNotice readout={notice.readout} detail={notice.detail} />
      )}

      {!live || !confirming ? null : (
        <RevokeConfirmation
          holder={readouts.displayName}
          startedAt={startedAt}
          error={error}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      )}

      {live && !confirming ? (
        <div className="flex">
          <Button variant="danger" onClick={onSelect}>
            Revoke access
          </Button>
        </div>
      ) : null}
    </li>
  )
}
