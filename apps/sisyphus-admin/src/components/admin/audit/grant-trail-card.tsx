import { DataReadout } from '@sisyphus-admin/components/admin/data-readout'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  FieldError,
  LoadingState,
  StateChip,
} from '@sisyphus-admin/components/ui'

import type { GrantTrailReadouts } from './grant-trail'

/**
 * A user's access history — every grant and every revocation (FR-183, FR-184, SC-053).
 *
 * Read-only, and visibly so: there is no control on this card, because revoking access belongs on
 * the access screen and offering it here would put a write next to a history that cannot be edited.
 * The same rule `RoleChangeHistory` follows, for the same reason.
 *
 * Presentational — it takes readouts, not a query — so the empty state, the loading state and the
 * refusal state are testable without a query client.
 */
interface GrantTrailCardProps {
  readonly rows: readonly GrantTrailReadouts[]
  /** Whether the read is still in flight, so an empty list is not mistaken for "nothing happened". */
  readonly loading?: boolean
  readonly error?: FieldErrorContent
}

export const GrantTrailCard = ({ rows, loading = false, error }: GrantTrailCardProps) => (
  <Card aria-label="Access history">
    <CardHeader>
      <span>profile access history</span>
      <StateChip>{loading ? 'reading' : `entries ${String(rows.length)}`}</StateChip>
    </CardHeader>

    <CardBody className="gap-default flex flex-col">
      <p className="type-body text-graphite measure-prose">
        Every execution profile this user has been granted, and every revocation, with the admin who
        made it. A revocation is a write, never a delete — which is why this list is both the access
        set and its history.
      </p>

      {error === undefined ? null : <FieldError {...error} />}

      {rows.length === 0 ? (
        <>
          {loading ? <LoadingState>reading this user’s access history</LoadingState> : null}
          {loading || error !== undefined ? null : (
            <EmptyState>no access changes recorded for this user</EmptyState>
          )}
        </>
      ) : (
        <ol className="gap-default flex flex-col">
          {rows.map((row) => (
            <li
              key={row.id}
              className="gap-close border-hairline p-close flex flex-wrap rounded-sm border"
            >
              <DataReadout label="profile" value={row.profile} />
              <DataReadout label="state" value={row.state} />
              <DataReadout label="granted" value={row.grantedAt} />
              <DataReadout label="granted by" value={row.grantedBy} />
              <DataReadout label="revoked" value={row.revokedAt} />
              <DataReadout label="revoked by" value={row.revokedBy} />
            </li>
          ))}
        </ol>
      )}
    </CardBody>
  </Card>
)
