import { DataReadout } from '@sisyphus-admin/components/admin'
import { StateChip } from '@sisyphus-admin/components/ui'

/**
 * The corrections written on a run, **including the ones that did not land** (FR-049, SC-004).
 *
 * Filtering to delivered corrections would be the silent drop with extra steps: the person who wrote
 * the guidance would see their text disappear and would reasonably assume the agent had it. So every
 * correction is listed with its delivery outcome, and a failure carries the reason the executor
 * reported — including the one that matters most, a turn written to the agent that was never echoed
 * back and therefore cannot honestly be called delivered.
 *
 * There is no retry button. A correction is an additional user turn in a live conversation; sending
 * the same guidance twice because a delivery could not be confirmed is a decision for the person who
 * wrote it, and they make it by writing it again.
 */

/** One correction as the panel renders it. */
export interface CorrectionReadout {
  readonly id: string
  /** Submission order — the order it will be delivered in. */
  readonly sequence: number
  readonly body: string
  /** `pending` · `delivered` · `failed` · `rejected`. */
  readonly outcome: string
  /** Present on a failure or a refusal, and shown verbatim. */
  readonly failureReason: string | null
  /** Preformatted by the caller, so this component holds no clock. */
  readonly submittedAt: string
}

interface CorrectionListProps {
  readonly corrections: readonly CorrectionReadout[]
}

export const CorrectionList = ({ corrections }: CorrectionListProps) => {
  if (corrections.length === 0) {
    return <p className="type-data-mono text-graphite">no corrections written on this run</p>
  }

  return (
    <ol className="gap-close flex flex-col" aria-label="Corrections">
      {corrections.map((correction) => (
        <li key={correction.id} className="gap-tight border-hairline p-close flex flex-col border">
          <div className="gap-default flex flex-wrap items-center">
            <DataReadout label="order" value={String(correction.sequence)} />
            <DataReadout label="written" value={correction.submittedAt} />
            <StateChip>{correction.outcome.toUpperCase()}</StateChip>
          </div>

          <p className="type-body text-ink measure-prose">{correction.body}</p>

          {correction.failureReason === null ? null : (
            <p className="type-data-mono text-rust measure-prose">
              <span className="type-label-mono">not delivered</span> {correction.failureReason}
            </p>
          )}
        </li>
      ))}
    </ol>
  )
}
