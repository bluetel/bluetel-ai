import { DataReadout } from '@sisyphus-admin/components/admin/data-readout'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import { Card, CardBody, CardHeader, FieldError, StateChip } from '@sisyphus-admin/components/ui'

import type { ConfigurationTrailReadouts } from './configuration-trail'

/**
 * The configuration change trail (FR-178).
 *
 * The third trail on this screen, and the one it was missing: bundle registrations and
 * replacements, workspace and profile edits, integration changes, grants, role changes and owner
 * reassignments — everything `recordConfigurationChange` has been writing since the first bundle
 * was registered.
 *
 * Read-only, and visibly so. There is no control on this card, for the same reason there is none on
 * `GrantTrailCard` or `RoleChangeHistory`: the table is append-only, and an affordance offered for
 * something that cannot be done is a lie about the record.
 *
 * Presentational — it takes readouts, not a query — so the empty state, the loading state and the
 * refusal state are testable without a query client.
 */
interface ConfigurationTrailCardProps {
  readonly rows: readonly ConfigurationTrailReadouts[]
  /** Whether the read is still in flight, so an empty list is not mistaken for "nothing happened". */
  readonly loading?: boolean
  readonly error?: FieldErrorContent
}

export const ConfigurationTrailCard = ({
  rows,
  loading = false,
  error,
}: ConfigurationTrailCardProps) => (
  <Card aria-label="Configuration changes">
    <CardHeader>
      <span>configuration change history</span>
      <StateChip>{loading ? 'reading' : `entries ${String(rows.length)}`}</StateChip>
    </CardHeader>

    <CardBody className="gap-default flex flex-col">
      <p className="type-body text-graphite measure-prose">
        Every change to platform configuration, with the admin who made it — a setup bundle
        registered or its archive replaced, a workspace or execution profile edited, an integration
        enabled or disabled, access granted or revoked. Appended only; nothing here can be edited or
        removed. A change with no admin against it was made by the platform itself.
      </p>

      {error === undefined ? null : <FieldError {...error} />}

      {rows.length === 0 ? (
        <p className="type-data-mono text-graphite">
          {loading ? 'reading' : 'no configuration changes recorded'}
        </p>
      ) : (
        <ol className="gap-default flex flex-col">
          {rows.map((row) => (
            <li
              key={row.id}
              className="gap-close border-hairline p-close flex flex-wrap rounded-sm border"
            >
              <DataReadout label="entity" value={row.entity} />
              <DataReadout label="action" value={row.action} />
              <DataReadout label="id" value={row.entityId} />
              <DataReadout label="version" value={row.version} />
              <DataReadout label="actor" value={row.actor} />
              <DataReadout label="at" value={row.at} />
              <DataReadout label="detail" value={row.detail} />
            </li>
          ))}
        </ol>
      )}
    </CardBody>
  </Card>
)
