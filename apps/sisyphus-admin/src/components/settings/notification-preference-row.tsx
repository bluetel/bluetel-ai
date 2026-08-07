import { ElapsedReadout } from '@sisyphus-admin/components/admin'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import { Button, FieldError, StateChip } from '@sisyphus-admin/components/ui'

import type { PreferenceReadouts } from './preference-readouts'

interface NotificationPreferenceRowProps {
  readouts: PreferenceReadouts
  /** `Date.now()` when this row's change started, or `undefined` when nothing is in flight. */
  startedAt?: number
  error?: FieldErrorContent
  /** Called with the value the caller is asking for, never with a toggle of a value guessed here. */
  onChange: (enabled: boolean) => void
}

/**
 * One notification event, its current setting, and where that setting came from (T158, FR-138).
 *
 * ## Three things are always on the row, and the third is the one that matters
 *
 * The state chip says what will happen — `notifying` or `muted` — and beside it, in the metadata
 * face, the row says whether that is `your choice` or the `default`. The marker is on **every** row
 * rather than only on the defaulted ones, because a marker that appears sometimes reads as a
 * warning badge; one that is always present reads as a column, which is what it is.
 *
 * Without it this screen would be a lie of the most convincing kind. Absence of a stored row means
 * *notify*, so a person who has never opened this page has eight events "on" — and eight switches
 * rendered "on" with nothing else said would tell them they had configured this. They had not, and
 * the difference is exactly what would show up the day the platform's default changed underneath
 * them.
 *
 * ## The control names the change, not the state
 *
 * `Mute this event`, not a switch reading `on`. A switch has to be read together with its label to
 * be understood, and gets that wrong under a screen reader more often than not; a button whose
 * label is the sentence "what pressing this does" cannot be misread. The accessible name carries
 * the event too, so `Mute this event` is not the fourth identically-named button on the screen.
 *
 * The row is presentational: it renders what it is given and calls back with the value asked for.
 * The mutation, the in-flight bookkeeping and the refusal all belong to the panel.
 */
export const NotificationPreferenceRow = ({
  readouts,
  startedAt,
  error,
  onChange,
}: NotificationPreferenceRowProps) => {
  const detailId = `${readouts.event}-detail`
  const pending = startedAt !== undefined

  return (
    <li className="gap-close border-hairline p-close flex flex-col rounded-sm border">
      <div className="gap-close flex flex-wrap items-center justify-between">
        <span className="type-body text-ink">{readouts.label}</span>
        <span className="gap-tight flex items-center">
          <StateChip>{readouts.stateReadout}</StateChip>
          <span className="type-label-mono text-graphite">{readouts.origin}</span>
        </span>
      </div>

      <p id={detailId} className="type-body text-graphite measure-prose">
        {readouts.detail}
      </p>

      {error === undefined ? null : <FieldError code={error.code} action={error.action} />}

      <div className="flex">
        {pending ? (
          <Button pending readout={<ElapsedReadout verb="Saving" startedAt={startedAt} />} />
        ) : (
          <Button
            aria-label={`${readouts.action}: ${readouts.label}`}
            aria-describedby={detailId}
            onClick={() => {
              onChange(!readouts.enabled)
            }}
          >
            {readouts.action}
          </Button>
        )}
      </div>
    </li>
  )
}
