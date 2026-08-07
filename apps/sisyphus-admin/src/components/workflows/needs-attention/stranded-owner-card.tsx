'use client'

import { DataReadout, describeTrpcError } from '@sisyphus-admin/components/admin'
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  FieldError,
  LoadingState,
  StateChip,
} from '@sisyphus-admin/components/ui'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import { toWorkflowRowReadouts } from '@sisyphus-admin/components/workflows'
import type { LaunchOption } from '@sisyphus-admin/components/workflows/new'
import { api } from '@sisyphus-admin/trpc'
import { useState } from 'react'

// `useNow` is not on `components/workflows`'s barrel, and this module may not add it there. One
// clock per page is the rule it exists to keep, so it is imported from the module rather than
// copied — a second interval would make two durations on the same screen disagree.
import { useNow } from '../use-now'

import { awaitingReassignmentInput } from './needs-attention-input'
import type { StrandedOwner } from './needs-attention-input'
import type { ReassignmentNotice } from './reassignment-outcome'
import { describeReassignment, describeReassignmentError } from './reassignment-outcome'
import { ReassignmentRow } from './reassignment-row'

/**
 * Every run one deactivated owner still holds (T088, FR-134, FR-176).
 *
 * One card, one query. A component per stranded owner rather than one query for all of them,
 * because `workflow.list` filters on a single `ownerUserId` — and because the grouping is the
 * information: "these four runs were Ada's" is what an admin needs in order to decide where they
 * should go, and a flat list of eleven runs from three people is not.
 *
 * ## Why the list is invalidated rather than patched
 *
 * A reassignment moves the run off this owner, so it leaves this list *and* the count in the header
 * above changes. Writing the result into the cache by hand would update one and not the other, and
 * a hand-patched list is the one that quietly disagrees with the database.
 */

interface StrandedOwnerCardProps {
  owner: StrandedOwner
  /** Active users this owner's runs may be handed to. */
  candidates: readonly LaunchOption[]
  /** How each candidate reads, so the notice can say who is accountable rather than name an id. */
  candidateNames: Readonly<Record<string, string>>
}

export const StrandedOwnerCard = ({
  owner,
  candidates,
  candidateNames,
}: StrandedOwnerCardProps) => {
  const [selections, setSelections] = useState<Readonly<Record<string, string>>>({})
  const [busyId, setBusyId] = useState<string | undefined>(undefined)
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined)
  const [error, setError] = useState<FieldErrorContent | undefined>(undefined)
  const [notice, setNotice] = useState<{ id: string; notice: ReassignmentNotice } | undefined>(
    undefined,
  )

  const utils = api.useUtils()
  const workflows = api.workflow.list.useQuery(awaitingReassignmentInput(owner.userId))
  const reassign = api.workflow.reassignOwner.useMutation()

  const now = useNow()
  const rows = (workflows.data?.items ?? []).map((item) => toWorkflowRowReadouts(item, now))

  return (
    <Card aria-label={`Runs owned by ${owner.displayName}`}>
      <CardHeader>
        <span>{owner.displayName}</span>
        <StateChip>{`flagged ${String(owner.flaggedCount)}`}</StateChip>
      </CardHeader>

      <CardBody className="gap-default flex flex-col">
        <div className="gap-default flex flex-wrap">
          <DataReadout label="deactivated owner" value={owner.email} />
          <DataReadout label="flagged runs" value={String(owner.flaggedCount)} />
          <DataReadout label="visible to you" value={String(rows.length)} />
        </div>

        <p className="type-body text-graphite measure-prose">
          Deactivating a user does not stop their runs. It flags every one still in flight so that
          somebody has to take it on — history stays attributed to them either way, because they did
          start the work.
        </p>

        {workflows.error === null ? null : <FieldError {...describeTrpcError(workflows.error)} />}

        {workflows.isPending ? <LoadingState>reading this owner’s runs</LoadingState> : null}

        {workflows.isPending || rows.length > 0 ? null : (
          <EmptyState>none of these runs are within what you are permitted to see</EmptyState>
        )}

        {rows.map((row) => (
          <ReassignmentRow
            key={row.id}
            row={row}
            candidates={candidates}
            selectedUserId={selections[row.id] ?? ''}
            startedAt={busyId === row.id ? startedAt : undefined}
            error={busyId === row.id ? error : undefined}
            notice={notice?.id === row.id ? notice.notice : undefined}
            onSelect={(userId) => {
              setSelections((current) => ({ ...current, [row.id]: userId }))
              setError(undefined)
            }}
            onReassign={() => {
              const ownerUserId = selections[row.id] ?? ''
              setBusyId(row.id)
              setStartedAt(Date.now())
              setNotice(undefined)

              reassign.mutate(
                { workflowId: row.id, ownerUserId },
                {
                  onSuccess: (result) => {
                    setStartedAt(undefined)
                    setBusyId(undefined)
                    setError(undefined)
                    setNotice({
                      id: row.id,
                      notice: describeReassignment(
                        result,
                        candidateNames[ownerUserId] ?? 'The new owner',
                      ),
                    })
                    void utils.workflow.list.invalidate()
                    void utils.admin.users.list.invalidate()
                  },
                  onError: (failure) => {
                    setStartedAt(undefined)
                    setBusyId(undefined)
                    setError(describeReassignmentError(failure))
                  },
                },
              )
            }}
          />
        ))}
      </CardBody>
    </Card>
  )
}
