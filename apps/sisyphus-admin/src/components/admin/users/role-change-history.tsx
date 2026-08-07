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

import type { RoleChangeEntry } from './role-change-entry'
import { toRoleChangeReadouts } from './role-change-entry'

interface RoleChangeHistoryProps {
  entries: readonly RoleChangeEntry[]
  /** Whether the read is still in flight, so an empty list is not mistaken for "nothing happened". */
  loading?: boolean
  /**
   * A refusal from the read itself. Separate from {@link RoleChangeHistoryProps.loading} because on
   * an audit trail the two answers a reader must be able to tell apart are "nothing was recorded"
   * and "nothing could be read".
   */
  error?: FieldErrorContent
}

/**
 * The append-only role and activation history (FR-177, FR-201).
 *
 * Read-only, and visibly so: there is no control on this card, because the table is append-only
 * and offering an edit affordance for something that cannot be edited would be a lie about the
 * audit trail. Newest first, which is the order the procedure returns.
 *
 * ## Why a failed read may not render the empty case
 *
 * This card had three states and needed four. A query that **refused** left it saying `no changes
 * recorded yet`, which on an audit trail is not a cosmetic defect — it is the panel asserting that
 * nothing happened, to an admin who came here to find out whether something did. So a refusal is
 * reported as a refusal, with a code and a next action (FR-031), and the empty line is withheld:
 * the only honest thing this card can say about a trail it could not read is nothing at all about
 * its contents.
 */
export const RoleChangeHistory = ({ entries, loading = false, error }: RoleChangeHistoryProps) => (
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

      {error === undefined ? null : <FieldError {...error} className="measure-prose" />}

      {entries.length === 0 ? (
        <>
          {loading ? <LoadingState>reading the history</LoadingState> : null}
          {loading || error !== undefined ? null : <EmptyState>no changes recorded yet</EmptyState>}
        </>
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
