import { cn } from '@sisyphus-admin/lib/cn'

/**
 * Clamp a reading to a percentage of its ceiling.
 *
 * Exported because the arithmetic is the part worth testing: a spend meter is fed live numbers, and
 * an over-cap value or a zero ceiling must render as a full or empty bar rather than as a fill that
 * overshoots its track or a `NaN` width.
 *
 * @param value - The current reading.
 * @param max - The ceiling. A non-positive ceiling reads as full when there is any value at all.
 * @returns A number between 0 and 100.
 */
export const meterFillPercent = (value: number, max: number): number => {
  if (!Number.isFinite(value) || value <= 0) return 0
  if (!Number.isFinite(max) || max <= 0) return 100
  return Math.min(100, (value / max) * 100)
}

interface MeterProps {
  value: number
  max: number
  /** What is being measured. Required — an unlabelled bar is a decoration, not an instrument. */
  label: string
  /** Human-readable reading announced alongside the number, e.g. `$4.10 of $10.00`. */
  valueText?: string
  className?: string
}

/**
 * A 4px track in `hairline` with a `signal` fill.
 *
 * Signal, because a meter reports a quantity rather than a machine state — `amber`, `verdigris` and
 * `rust` are locked to state (FR-025) and a spend bar that turned amber near its cap would be
 * exactly the decorative use of a state colour the system forbids. The state that a cap has been
 * hit is reported by a state chip, which is what state chips are for.
 */
export const Meter = ({ value, max, label, valueText, className }: MeterProps) => {
  const percent = meterFillPercent(value, max)

  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuetext={valueText}
      className={cn('h-meter bg-hairline w-full overflow-hidden rounded-sm', className)}
    >
      <div
        className="bg-signal duration-state ease-panel h-full rounded-sm transition-[width]"
        style={{ width: `${String(percent)}%` }}
      />
    </div>
  )
}
