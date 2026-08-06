'use client'

import { ChangeNotice, DataReadout, ElapsedReadout } from '@sisyphus-admin/components/admin'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  FieldError,
  StateChip,
} from '@sisyphus-admin/components/ui'
import type { WorkflowRowReadouts } from '@sisyphus-admin/components/workflows'
import type { LaunchOption } from '@sisyphus-admin/components/workflows/new'
import { LaunchSelect } from '@sisyphus-admin/components/workflows/new'
import Link from 'next/link'

import type { ReassignmentNotice } from './reassignment-outcome'

/**
 * One run whose owner was deactivated, with the control that gives it a new one (T088, FR-134,
 * FR-176).
 *
 * A fleet row plus one decision. It deliberately does not reuse `WorkflowRow` whole: that component
 * is a link and nothing else — the entire card is the anchor — so a select and a button inside it
 * would be interactive controls nested in a link, which is both invalid and unusable. The run id
 * stays a link, and the readouts beside it are the same `DataReadout` the fleet list uses.
 *
 * Presentational: every value and every callback arrives as a prop.
 */

interface ReassignmentRowProps {
  row: WorkflowRowReadouts
  /** Who this run may be handed to: active users other than its current owner. */
  candidates: readonly LaunchOption[]
  selectedUserId: string
  onSelect: (userId: string) => void
  onReassign: () => void
  /** `Date.now()` while this row's own reassignment is in flight. */
  startedAt?: number
  error?: FieldErrorContent
  notice?: ReassignmentNotice
}

export const ReassignmentRow = ({
  row,
  candidates,
  selectedUserId,
  onSelect,
  onReassign,
  startedAt,
  error,
  notice,
}: ReassignmentRowProps) => {
  const pending = startedAt !== undefined

  return (
    <Card aria-label={`Run ${row.runId} awaiting a new owner`}>
      <CardHeader>
        <Link href={`/workflows/${row.id}`} className="focus-ring type-data-mono text-signal">
          <span title={row.id}>{row.runId}</span>
        </Link>
        <StateChip state={row.state}>{row.stateReadout}</StateChip>
      </CardHeader>

      <CardBody className="gap-default flex flex-col">
        <div className="gap-default flex flex-wrap">
          <DataReadout label="owner" value={row.owner} />
          <DataReadout label={row.startedByLabel} value={row.startedBy} />
          <DataReadout label="workspace" value={row.workspace} />
          <DataReadout label="profile" value={row.executionProfile} />
          <DataReadout label="started" value={row.startedAt} />
          <DataReadout label="duration" value={row.duration} />
          <DataReadout label="spend" value={row.spend} />
        </div>

        <p className="type-body text-graphite measure-prose">
          Its owner has been deactivated, so nobody is accountable for it. The run itself was not
          interrupted — deactivation flags a run rather than stopping it — but nothing is watching
          it until somebody takes it on.
        </p>

        {error === undefined ? null : <FieldError code={error.code} action={error.action} />}

        <div className="gap-close flex flex-wrap items-end">
          <LaunchSelect
            label="New owner"
            value={selectedUserId}
            options={candidates}
            placeholder={
              candidates.length === 0 ? 'No active user is available' : 'Choose an active user'
            }
            hint="ownership does not grant profile access; it confers the rights over this one run"
            disabled={pending || candidates.length === 0}
            onChange={onSelect}
          />
          {pending ? (
            <Button
              variant="secondary"
              pending
              readout={<ElapsedReadout verb="Reassigning" startedAt={startedAt} />}
            />
          ) : (
            <Button variant="secondary" disabled={selectedUserId === ''} onClick={onReassign}>
              Reassign
            </Button>
          )}
        </div>

        {notice === undefined ? null : (
          <ChangeNotice readout={notice.readout} detail={notice.detail} />
        )}
      </CardBody>
    </Card>
  )
}
