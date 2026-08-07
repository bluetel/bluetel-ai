import { DataReadout } from '@sisyphus-admin/components/admin'
import { FieldError, StateChip } from '@sisyphus-admin/components/ui'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'

/**
 * A prefilled value the execution profile forbids changing (T080, FR-023, FR-123).
 *
 * ## It is a readout, not a disabled input
 *
 * A greyed-out control says "not right now" — it is the shape of something temporarily unavailable,
 * and an operator reasonably reads it as a thing that will become editable once the page settles or
 * once some other field is filled in. A locked field is not that: it will never be editable on this
 * run, because the profile fixed it deliberately. So it renders through {@link DataReadout}, the
 * same component every machine value on the admin surface goes through, with a `locked` chip beside
 * it.
 *
 * Every interactive element reports its state (FR-023). The honest report for this one is that it
 * is not interactive, and there is nothing to type into.
 *
 * ## Why it is never hidden
 *
 * The run uses the value. FR-122 prefills every value precisely so the operator can see what they
 * are about to spend money on, and a hidden locked field is one nobody was shown that merely looks
 * tidy.
 */

interface LockedValueProps {
  /** The field's caption. `label-mono` casing is applied by the token, not by the caller. */
  label: string
  /** The profile's value, as it will be used. */
  value: string
  /** What a blank value reads as — a cap the profile does not set is "no cap", not an empty box. */
  blankReadout?: string
  /** One clause about the consequence, where the field's is not obvious. */
  hint?: string
  /**
   * A refusal, for the case the held value differs from the profile's anyway. Rare by construction
   * — nothing on this screen can type into a readout — and reported rather than dropped, because a
   * silently discarded override is the exact defect FR-123 exists to prevent.
   */
  error?: FieldErrorContent
}

export const LockedValue = ({
  label,
  value,
  blankReadout = 'not set',
  hint,
  error,
}: LockedValueProps) => (
  <div className="gap-tight flex flex-col" data-state="locked">
    <div className="gap-close flex items-start justify-between">
      <DataReadout label={label} value={value.trim() === '' ? blankReadout : value} />
      <StateChip>locked</StateChip>
    </div>
    <p className="type-data-mono text-graphite">
      {hint === undefined
        ? 'fixed by the execution profile for every run on it'
        : `${hint}; fixed by the execution profile for every run on it`}
    </p>
    {error === undefined ? null : <FieldError code={error.code} action={error.action} />}
  </div>
)
