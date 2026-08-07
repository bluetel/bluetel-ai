import { DataReadout } from '@sisyphus-admin/components/admin/data-readout'
import { Card, CardBody, CardHeader, StateChip } from '@sisyphus-admin/components/ui'

import type { RoleChangeEntry } from './role-change-entry'
import { toRoleChangeReadouts } from './role-change-entry'

interface RoleChangeHistoryProps {
  entries: readonly RoleChangeEntry[]
  /** Whether the read is still in flight, so an empty list is not mistaken for "nothing happened". */
  loading?: boolean
}

/**
 * The append-only role and activation history (FR-177).
 *
 * Read-only, and visibly so: there is no control on this card, because the table is append-only
 * and offering an edit affordance for something that cannot be edited would be a lie about the
 * audit trail. Newest first, which is the order the procedure returns.
 */
export const RoleChangeHistory = ({ entries, loading = false }: RoleChangeHistoryProps) => (
  <Card>
    <CardHeader>
      <span>role and activation history</span>
      <StateChip>{loading ? 'reading' : `entries ${String(entries.length)}`}</StateChip>
    </CardHeader>
    <CardBody className="gap-default flex flex-col">
      <p className="type-body text-graphite measure-prose">
        Every grant, revocation, activation and deactivation, with the admin who made it. Appended
        only — nothing here can be edited or removed.
      </p>

      {entries.length === 0 ? (
        <p className="type-data-mono text-graphite">
          {loading ? 'reading' : 'no changes recorded yet'}
        </p>
      ) : (
        <ol className="gap-default flex flex-col">
          {entries.map((entry) => {
            const readouts = toRoleChangeReadouts(entry)

            return (
              <li
                key={readouts.id}
                className="gap-close border-hairline p-close flex flex-wrap rounded-sm border"
              >
                <DataReadout label="change" value={readouts.change} />
                <DataReadout label="subject" value={readouts.subject} />
                <DataReadout label="actor" value={readouts.actor} />
                <DataReadout label="at" value={readouts.at} />
                <DataReadout label="reason" value={readouts.reason} />
              </li>
            )
          })}
        </ol>
      )}
    </CardBody>
  </Card>
)
