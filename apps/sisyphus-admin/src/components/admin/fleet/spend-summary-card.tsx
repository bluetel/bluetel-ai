import { DataReadout } from '@sisyphus-admin/components/admin/data-readout'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  FieldError,
  Meter,
  StateChip,
} from '@sisyphus-admin/components/ui'

import type { FleetSpendGrouping } from './spend-grouping'
import { FLEET_SPEND_GROUPINGS, GROUPING_LABELS } from './spend-grouping'
import type { SpendReadouts } from './spend-readouts'

/**
 * Attributable spend across the fleet (FR-041, FR-156, FR-190).
 *
 * ## Presentational
 *
 * It takes readouts, not a query, so the empty state, the loading state and the refusal state are
 * all testable without a query client. The query lives in `./fleet-panel`.
 *
 * ## The grouping toggles offer three options and not four
 *
 * `user` is a grouping the procedure accepts and this card does not offer, because these rows are
 * ordered by spend descending and a list of people in that order is the ranked comparison between
 * individuals FR-156 forbids. See `./spend-grouping.ts` — the omission is enforced in the parser,
 * not merely in this markup.
 *
 * ## The total is the scoped total
 *
 * Every figure here is what the caller is permitted to see. `workflow.spendSummary` composes the
 * FR-190 base selector into the aggregate and folds its total out of the groups it returned, so
 * there is no "everything else" to display and this card must never invent one — a spend total that
 * included an invisible run would disclose that the run exists (SC-051). The prose says so, because
 * an operator reading a total needs to know what it is a total of.
 *
 * The meter is `signal`, per the primitive: a quantity is not a machine state, and a spend bar that
 * turned amber near a cap would be the decorative use of a state colour the system forbids (FR-025).
 */
interface SpendSummaryCardProps {
  readonly readouts: SpendReadouts
  readonly grouping: FleetSpendGrouping
  readonly onGroupingChange: (grouping: FleetSpendGrouping) => void
  /** True while the first read is in flight, so an empty summary is not read as "nothing spent". */
  readonly loading?: boolean
  readonly error?: FieldErrorContent
}

export const SpendSummaryCard = ({
  readouts,
  grouping,
  onGroupingChange,
  loading = false,
  error,
}: SpendSummaryCardProps) => (
  <Card aria-label="Spend">
    <CardHeader>
      <span>spend</span>
      <StateChip>{loading ? 'reading' : `groups ${String(readouts.groups.length)}`}</StateChip>
    </CardHeader>

    <CardBody className="gap-default flex flex-col">
      <p className="type-body text-graphite measure-prose">
        Spend across every run you are permitted to see, grouped by client, workspace or execution
        profile. The total is a total of exactly those runs — a run outside your scope is not in it,
        and is not in the counts either.
      </p>

      {error === undefined ? null : <FieldError {...error} />}

      <div className="gap-tight flex flex-col">
        <span className="type-label-mono text-graphite">group by</span>
        <div className="gap-tight flex flex-wrap">
          {FLEET_SPEND_GROUPINGS.map((option) => (
            <Button
              key={option}
              variant={grouping === option ? 'secondary' : 'quiet'}
              aria-pressed={grouping === option}
              onClick={() => {
                onGroupingChange(option)
              }}
            >
              {GROUPING_LABELS[option]}
            </Button>
          ))}
        </div>
      </div>

      <div className="gap-close flex flex-wrap">
        <DataReadout label="runs" value={readouts.workflows} />
        <DataReadout label="spend" value={readouts.spend} />
        <DataReadout label="turns" value={readouts.turns} />
      </div>

      {readouts.groups.length === 0 ? (
        <p className="type-data-mono text-graphite">
          {loading ? 'reading' : 'no spend recorded in your scope'}
        </p>
      ) : (
        <ol className="gap-close flex flex-col">
          {readouts.groups.map((group) => (
            <li key={group.key} className="gap-tight border-hairline p-close flex flex-col border">
              <div className="gap-close flex flex-wrap">
                <DataReadout label={grouping} value={group.name} />
                <DataReadout label="runs" value={group.workflows} />
                <DataReadout label="spend" value={group.spend} />
                <DataReadout label="turns" value={group.turns} />
              </div>
              <Meter
                value={group.share}
                max={100}
                label={`${group.name} share of visible spend`}
                valueText={`${group.spend} of ${readouts.spend}`}
              />
            </li>
          ))}
        </ol>
      )}
    </CardBody>
  </Card>
)
