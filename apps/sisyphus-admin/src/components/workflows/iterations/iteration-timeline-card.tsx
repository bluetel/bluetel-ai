import { DataReadout } from '@sisyphus-admin/components/admin'
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  LoadingState,
  StateChip,
} from '@sisyphus-admin/components/ui'

import type { IterationTimelineReadouts } from './iteration-readouts'

/**
 * What the autonomous loop actually did, iteration by iteration (T127, FR-061, FR-062, FR-119).
 *
 * ## Why the unresolved findings are at the top
 *
 * A reader opening an autonomous run that stopped for attention is not browsing. They are asking
 * one question — *what is still wrong?* — and the answer is the last thing they would reach if the
 * card were laid out chronologically, three iterations down, mixed in with the findings that were
 * fixed two passes ago. So the standing sentence and the unresolved list come first, and the
 * per-iteration record follows for anyone who wants to see how it got there.
 *
 * ## Announced, not merely displayed
 *
 * The standing is a `role="status"` region, so a screen reader hears it rather than only finding it
 * by navigating in. `role="alert"` would be wrong: the run has already stopped, and interrupting
 * somebody about the past is noise rather than urgency.
 *
 * ## No colour, and no control
 *
 * The chip is the idle graphite one. Colour on this panel means machine state (FR-025, FR-030), and
 * a review verdict is not a workflow state — tinting a failed iteration red would be a state colour
 * borrowed to make a point, and it would put three different reds on a page whose whole colour
 * vocabulary is "what is this machine doing". There is likewise nothing to press: a fourth
 * iteration is refused by a check constraint (FR-061), so a retry button here would be a control
 * that cannot work.
 *
 * ## The bound is in the readout, not in a legend
 *
 * Every ordinal renders as `2 of 3`. A reader should not have to know FR-061 to understand why a
 * run stopped, and a footnote explaining the maximum is a footnote nobody reads.
 */
interface IterationTimelineCardProps {
  readonly timeline: IterationTimelineReadouts
  readonly loading?: boolean
}

export const IterationTimelineCard = ({
  timeline,
  loading = false,
}: IterationTimelineCardProps) => (
  <Card aria-label="Iterations">
    <CardHeader>
      <span>iterations</span>
      <StateChip>{loading ? 'reading' : timeline.readout}</StateChip>
    </CardHeader>
    <CardBody className="gap-default flex flex-col">
      {loading ? (
        <LoadingState>reading this run</LoadingState>
      ) : (
        <div role="status" className="gap-hair flex flex-col">
          <p className="type-body text-ink measure-prose">{timeline.statement}</p>
          {timeline.exhausted ? (
            <p className="type-body text-graphite measure-prose">
              A fourth iteration was not attempted. The work, its pull requests and every review are
              recorded; what to do next is a decision for a person.
            </p>
          ) : null}
        </div>
      )}

      {loading || timeline.unresolved.length === 0 ? null : (
        <div className="gap-close flex flex-col">
          <span className="type-label-mono text-graphite">unresolved</span>
          <ul className="gap-close flex flex-col">
            {timeline.unresolved.map((finding) => (
              <li key={finding.key} className="gap-default flex flex-wrap">
                <DataReadout label="severity" value={finding.severity} />
                {finding.location === '' ? null : (
                  <DataReadout label="where" value={finding.location} />
                )}
                <DataReadout label="finding" value={finding.summary} />
              </li>
            ))}
          </ul>
        </div>
      )}

      <ol className="gap-default flex flex-col">
        {timeline.iterations.map((iteration) => (
          <li key={iteration.id} className="gap-close flex flex-col">
            <div className="gap-default flex flex-wrap">
              <DataReadout label="iteration" value={iteration.ordinal} />
              <DataReadout label="review" value={iteration.verdict} />
              <DataReadout label="findings" value={iteration.findingCount} />
            </div>

            <ul className="gap-hair flex flex-col">
              {iteration.findings.map((finding) => (
                <li key={finding.key} className="gap-default flex flex-wrap">
                  <DataReadout label="severity" value={finding.severity} />
                  {finding.location === '' ? null : (
                    <DataReadout label="where" value={finding.location} />
                  )}
                  <DataReadout label="finding" value={finding.summary} />
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>

      {loading || timeline.iterations.length > 0 ? null : (
        <EmptyState>no development iterations recorded</EmptyState>
      )}
    </CardBody>
  </Card>
)
