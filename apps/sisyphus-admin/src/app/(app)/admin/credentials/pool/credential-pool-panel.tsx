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
import { api } from '@sisyphus-admin/trpc'

import { PoolGroupCard } from './pool-group-card'
import { toPoolGroupReadout, toPoolSummary } from './pool-readout'

/**
 * `/admin/credentials/pool` — the capacity report (T113, FR-053, FR-054, FR-055, FR-074, SC-011).
 *
 * One query and no mutations, which is the shape of the screen rather than an omission. The pool is
 * steered from `/admin/credentials` and `/admin/credentials/groups`; this page answers **whether it
 * needs steering**, and a page that could change what it was reporting would make "what is happening
 * to the pool" depend on somebody having it open.
 *
 * ## The banner is the page
 *
 * SC-011 asks for one view in which an under-sized group is distinguishable from an under-sized pool
 * inside thirty seconds. The verdict sentence at the top is that thirty seconds; everything below it
 * exists so an administrator can check it rather than take it on trust. That ordering is deliberate
 * — a page that opened with a table of seats would make the reader do the comparison the server has
 * already made.
 *
 * ## `includeArchived` is off, unlike the seat list
 *
 * `/admin/credentials` shows archived seats, because FR-005 archives precisely so a finished run can
 * still say what identity it worked as. Here they would be wrong: this page counts **capacity**, and
 * an archived credential is not capacity. The server excludes them from the group totals even when
 * asked for them, and this page does not ask.
 */
export const CredentialPoolPanel = () => {
  const pool = api.admin.credentialPool.view.useQuery({})

  if (pool.error !== null) {
    return (
      <Card>
        <CardHeader>
          <span>agent credential pool</span>
          <StateChip>unavailable</StateChip>
        </CardHeader>
        <CardBody>
          <FieldError {...describeTrpcError(pool.error)} />
        </CardBody>
      </Card>
    )
  }

  if (pool.isPending) {
    return (
      <Card>
        <CardHeader>
          <span>agent credential pool</span>
          <StateChip>reading</StateChip>
        </CardHeader>
        <CardBody>
          <LoadingState>reading the pool</LoadingState>
        </CardBody>
      </Card>
    )
  }

  const summary = toPoolSummary(pool.data)
  const groups = pool.data.groups.map(toPoolGroupReadout)

  return (
    <div className="gap-section flex flex-col">
      <Card>
        <CardHeader>
          <span>capacity</span>
          <StateChip>{summary.verdict.replace('_', ' ')}</StateChip>
        </CardHeader>
        <CardBody className="gap-default flex flex-col">
          <p className="type-heading text-ink measure-prose">{summary.headline}</p>
          <p className="type-body text-graphite measure-prose">{summary.detail}</p>

          <div className="gap-default flex flex-wrap">
            <DataReadout label="seats" value={summary.seatCount} />
            <DataReadout label="free now" value={summary.selectableCount} />
            <DataReadout label="waiting" value={summary.queueDepth} />
            <DataReadout label="longest wait" value={summary.longestWait} />
            <DataReadout label="as at" value={summary.observedAt} />
          </div>

          {pool.data.queue.unattributableDepth === 0 ? null : (
            <p className="type-body text-graphite measure-prose">
              {`${String(pool.data.queue.unattributableDepth)} of those runs are attached to no credential group at all, so no amount of extra capacity will start them. They were launched without an execution profile, and a profile with attached groups is what gives a run something to draw on.`}
            </p>
          )}
        </CardBody>
      </Card>

      {groups.length === 0 ? <EmptyState>no credential groups exist yet</EmptyState> : null}

      {groups.map((group) => (
        <PoolGroupCard key={group.id} group={group} />
      ))}
    </div>
  )
}
