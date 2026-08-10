'use client'

import { DataReadout } from '@sisyphus-admin/components/admin'
import { Card, CardBody, CardHeader, EmptyState, StateChip } from '@sisyphus-admin/components/ui'

import type { PoolGroupReadout, PoolSeatReadout } from './pool-readout'

/**
 * One credential group's capacity, its holders and its queue (T113, FR-053, FR-054, FR-074).
 *
 * ## Why the group is a card and the seat is a row inside it
 *
 * The purchase an administrator makes is a seat **in a group** (FR-060, FR-061), and the question
 * this page answers is which group to make it in. Laying the pool out as one flat list of seats
 * would have made that the reader's arithmetic; laying it out as groups makes the comparison — this
 * group has two waiting and none free, that one has three free — a matter of looking down the page.
 *
 * A group with **no seats at all** still gets a card, and that is the case worth stating: it is the
 * most under-sized a group can be, and a layout built outward from credentials would have omitted
 * exactly the group most in need of buying for.
 *
 * ## The holder line always names all four kinds
 *
 * See `describeHolders` in `./pool-readout.ts` — FR-074's whole content is that a pool full of
 * parked holders is indistinguishable from an idle one unless the kinds are named, and a line that
 * dropped its zeroes would make `parked 0` an absence to notice rather than a nought to read.
 */

/** One seat's row. */
const PoolSeatRow = ({ seat }: { seat: PoolSeatReadout }) => (
  <div className="gap-tight border-hairline p-close flex flex-col border-t">
    <div className="gap-default flex flex-wrap items-center">
      <span className="type-data-mono text-ink">{seat.name}</span>
      {/*
        The chip takes its colour from the holding **run's** state where there is one, because that
        is the colour the rest of the console gives that run — a parked holder reads the same here as
        it does on the workflows list. A free seat, and a seat under a keep-alive exercise, have no
        run and so get the idle chip with the credential's own state written on it.
      */}
      {seat.holderWorkflowState === undefined ? (
        <StateChip>{seat.state}</StateChip>
      ) : (
        <StateChip state={seat.holderWorkflowState}>{seat.state}</StateChip>
      )}
      {seat.archived ? <StateChip>deleted</StateChip> : null}
    </div>

    <div className="gap-default flex flex-wrap">
      <DataReadout label="health" value={seat.health} />
      <DataReadout label="usable" value={seat.selectable ? 'yes' : 'no'} />
      <DataReadout label="holder" value={seat.holder} />
      <DataReadout label="last used" value={seat.lastUsed} />
      <DataReadout label="last exercised" value={seat.lastExercised} />
      {seat.coolingOffUntil === undefined ? null : (
        <DataReadout label="back at" value={seat.coolingOffUntil} />
      )}
    </div>

    <p className="type-data-mono text-graphite">{seat.consumption}</p>

    {seat.lastFailureReason === undefined ? null : (
      <p className="type-data-mono text-rust measure-prose">{seat.lastFailureReason}</p>
    )}
  </div>
)

export const PoolGroupCard = ({ group }: { group: PoolGroupReadout }) => (
  <Card>
    <CardHeader>
      <span>{group.name}</span>
      <StateChip>{group.pressure}</StateChip>
    </CardHeader>
    <CardBody className="gap-default flex flex-col">
      <p className="type-body text-graphite measure-prose">{group.verdict}</p>

      <div className="gap-default flex flex-wrap">
        <DataReadout label="seats" value={group.seatCount} />
        <DataReadout label="free now" value={group.selectableCount} />
        <DataReadout label="waiting" value={group.queueDepth} />
        <DataReadout label="longest wait" value={group.longestWait} />
        <DataReadout label="holders" value={group.holders} />
      </div>

      {group.enabled ? null : (
        <p className="type-body text-graphite measure-prose">
          This group is disabled, so every seat in it is withheld from future selection. Runs
          already holding one keep it until they finish.
        </p>
      )}

      {group.seats.length === 0 ? (
        <EmptyState>this group holds no agent credential</EmptyState>
      ) : (
        group.seats.map((seat) => <PoolSeatRow key={seat.id} seat={seat} />)
      )}
    </CardBody>
  </Card>
)
