import { DataReadout } from '@sisyphus-admin/components/admin'
import { Card, CardBody, CardHeader, Meter, StateChip } from '@sisyphus-admin/components/ui'

import type { CredentialWaitReadout } from './credential-wait'
import type { ParkingCountdownReadout } from './parking-countdown'
import type { CapReadout, WorkflowDetailReadouts } from './workflow-detail-readouts'

/**
 * The run, in one card (FR-014).
 *
 * Presentational, and deliberately the *whole* launch configuration rather than a summary of it:
 * this card is what an operator reads to answer "why did it get these settings", and a field left
 * off is a question they have to ask somebody.
 *
 * The meters are `signal`, because a meter reports a quantity. A spend bar that turned amber near
 * its cap would be a state colour used decoratively (FR-025); that a cap has been reached is
 * reported by the state chip, which is what state chips are for.
 */

/** A cap and its consumption. Uncapped is stated, never rendered as a ceiling of zero. */
const CapReading = ({ label, reading }: { label: string; reading: CapReadout }) => (
  <div className="gap-tight flex max-w-prose flex-1 flex-col">
    <DataReadout
      label={label}
      value={
        reading.cap === undefined
          ? `${reading.used} (uncapped)`
          : `${reading.used} / ${reading.cap}`
      }
    />
    {reading.meter === undefined ? null : (
      <Meter
        label={label}
        value={reading.meter.value}
        max={reading.meter.max}
        valueText={`${reading.used} of ${reading.cap ?? ''}`}
      />
    )}
  </div>
)

interface WorkflowSummaryCardProps {
  readonly detail: WorkflowDetailReadouts
  /**
   * The run's wait for an agent credential, if it has had one (003/SC-006).
   *
   * A separate prop rather than a field on {@link WorkflowDetailReadouts} because it is derived
   * from the *timeline*, which is a second query — see `./credential-wait.ts`. `undefined` for the
   * overwhelming majority of runs, which never waited.
   */
  readonly credentialWait?: CredentialWaitReadout
  /**
   * How long this run has before it parks, if it is paused (003/FR-047).
   *
   * A separate prop for the same reason the wait is: it is derived from the *timeline*, which is a
   * second query. `undefined` for every run that is not paused right now.
   */
  readonly parking?: ParkingCountdownReadout
}

export const WorkflowSummaryCard = ({
  credentialWait,
  detail,
  parking,
}: WorkflowSummaryCardProps) => (
  <Card aria-label="Run">
    <CardHeader>
      <span title={detail.id} className="type-data-mono">
        {detail.runId}
      </span>
      <StateChip state={detail.state}>{detail.stateReadout}</StateChip>
    </CardHeader>

    <CardBody className="gap-default flex flex-col">
      {/*
        First, above even the storage park, and for the same reason at one remove: a run that is
        waiting for an agent credential looks — from every other readout on this card — like a run
        that has stalled. It has no instance, no turns, no spend and no log, and 003/SC-006 says an
        engineer must be able to tell from this view alone that it is waiting and for how long.

        The duration is rendered beside the summary rather than folded into it, because "how long"
        is the question somebody scanning the card is asking; and the remedy is its own line,
        because the four FR-029 cases differ in exactly that sentence. `data-credential-wait`
        carries the fault flag so the difference between "wait" and "somebody must fix this" is
        assertable rather than a matter of reading the copy.
      */}
      {credentialWait === undefined ? null : (
        <div
          className="gap-hair flex flex-col"
          data-credential-wait={credentialWait.configurationFault ? 'fault' : 'waiting'}
        >
          <span className="type-label-mono text-graphite">
            {credentialWait.headline} · {credentialWait.waitedFor}
          </span>
          <p className="type-body text-ink measure-prose">{credentialWait.summary}</p>
          <p className="type-body text-graphite measure-prose">{credentialWait.remedy}</p>
          {credentialWait.groups.length === 0 ? null : (
            <p className="type-data-mono text-graphite measure-prose">
              groups searched: {credentialWait.groups.join(', ')}
            </p>
          )}
        </div>
      )}

      {/*
        The park ahead of a paused run (003/FR-047). Beside the two readouts above rather than
        buried among the fields, because it is the only thing on this card with a deadline on it:
        past the idle limit the instance and the disk go, and the remedy — resume it — is available
        only beforehand. `data-parking-countdown` carries whether the park is pending or owed, so
        the difference is assertable rather than a matter of reading the copy.

        Not a state chip. The run's state really is `paused` throughout, and a chip that said
        anything else would disagree with the supervision controls a few cards down.
      */}
      {parking === undefined ? null : (
        <div
          className="gap-hair flex flex-col"
          data-parking-countdown={parking.overdue ? 'due' : 'counting'}
        >
          <span className="type-label-mono text-graphite">
            {parking.headline} · {parking.remaining}
          </span>
          <p className="type-body text-ink measure-prose">{parking.explanation}</p>
          <p className="type-data-mono text-graphite measure-prose">
            paused for {parking.pausedFor}
          </p>
        </div>
      )}

      {/*
        First in the body, above every readout, because it is the one thing on this card that
        changes what an operator should do next: a run that appears to be `running` and producing
        nothing is a run somebody stops, and stopping it is what loses the work parking is holding
        (FR-082). Not a state chip — the run's state really is `running` while it parks, and the
        chip must go on agreeing with the heartbeat.
      */}
      {detail.storagePark === undefined ? null : (
        <div className="gap-hair flex flex-col" data-storage-park={detail.storagePark.waiting}>
          <span className="type-label-mono text-graphite">{detail.storagePark.headline}</span>
          <p className="type-body text-ink measure-prose">{detail.storagePark.explanation}</p>
          {detail.storagePark.cause === null ? null : (
            <p className="type-data-mono text-graphite measure-prose">{detail.storagePark.cause}</p>
          )}
        </div>
      )}

      {detail.needsReassignment ? (
        <p className="type-body text-ink measure-prose">
          This run&rsquo;s owner has been deactivated. Somebody must take it over before it can be
          supervised.
        </p>
      ) : null}

      <div className="gap-default flex flex-wrap">
        <DataReadout label={detail.startedByLabel} value={detail.startedBy} />
        <DataReadout label="owner" value={detail.owner} />
        <DataReadout label="type" value={detail.type} />
        <DataReadout label="workspace" value={detail.workspace} />
        <DataReadout label="ticket" value={detail.ticket} />
        <DataReadout label="profile" value={detail.executionProfile} />
        <DataReadout label="model" value={detail.model} />
        <DataReadout label="instance" value={detail.instanceType} />
        <DataReadout label="purchase" value={detail.purchaseMode} />
        <DataReadout label="result branch" value={detail.resultBranch} />
        <DataReadout label="started" value={detail.startedAt} />
        <DataReadout label="last moved" value={detail.lastMovedAt} />
        <DataReadout label="duration" value={detail.duration} />
        <DataReadout label="outcome" value={detail.outcome} />
      </div>

      <div className="gap-default flex flex-wrap">
        <CapReading label="turns" reading={detail.turns} />
        <CapReading label="spend" reading={detail.spend} />
      </div>

      {detail.outcome === detail.outcomeReason ? null : (
        <div className="gap-hair flex flex-col">
          <span className="type-label-mono text-graphite">why it ended there</span>
          <p className="type-body text-ink measure-prose">{detail.outcomeReason}</p>
        </div>
      )}

      {detail.promptTruncated ? (
        <p className="type-body text-graphite measure-prose">
          The assembled prompt was truncated oldest-comment-first to fit. What the agent was given
          is not the whole ticket thread.
        </p>
      ) : null}
    </CardBody>
  </Card>
)
