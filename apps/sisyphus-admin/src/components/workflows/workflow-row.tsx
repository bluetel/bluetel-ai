import { DataReadout } from '@sisyphus-admin/components/admin'
import { Card, CardBody, CardHeader, StateChip } from '@sisyphus-admin/components/ui'
import Link from 'next/link'

import type { WorkflowRowReadouts } from './workflow-listing'

/**
 * One run in the fleet list (FR-012).
 *
 * Presentational: it holds no state and issues no request, so it renders identically on the server
 * and in a test. Everything it shows arrives already shaped by `./workflow-listing`, which is where
 * the decisions worth asserting live.
 *
 * ## What is `data-mono` and what is not
 *
 * Every value on this card is a machine readout and is set in `data-mono` through `DataReadout`;
 * every caption above one is `label-mono`. The only Archivo on the card is the run's ticket
 * reference in the header, which is a thing a person wrote. That split is the rule DESIGN.md calls
 * "not a texture", and a row is where breaking it would be least visible and most damaging: a
 * column of durations set in the prose face stops being a column.
 *
 * ## Why the whole row is a link
 *
 * The list exists to be traversed. A row with an affordance somewhere inside it makes the operator
 * aim; a row that *is* the link does not — and it also means the browser's own middle-click and
 * copy-link behaviours work, which matters for a console people paste run URLs out of.
 */
interface WorkflowRowProps {
  readonly row: WorkflowRowReadouts
}

export const WorkflowRow = ({ row }: WorkflowRowProps) => (
  <Card aria-label={`Run ${row.runId}`}>
    <CardHeader>
      <Link href={`/workflows/${row.id}`} className="focus-ring type-data-mono text-signal">
        <span title={row.id}>{row.runId}</span>
      </Link>
      <StateChip state={row.state}>{row.stateReadout}</StateChip>
    </CardHeader>

    <CardBody className="gap-default flex flex-wrap">
      <DataReadout label={row.startedByLabel} value={row.startedBy} />
      <DataReadout label="owner" value={row.owner} />
      <DataReadout label="type" value={row.type} />
      <DataReadout label="workspace" value={row.workspace} />
      <DataReadout label="ticket" value={row.ticket} />
      <DataReadout label="model" value={row.model} />
      <DataReadout label="profile" value={row.executionProfile} />
      <DataReadout label="started" value={row.startedAt} />
      <DataReadout label="duration" value={row.duration} />
      <DataReadout label="turns" value={row.turns} />
      <DataReadout label="spend" value={row.spend} />
      <DataReadout label="outcome" value={row.outcome} />
    </CardBody>
  </Card>
)
