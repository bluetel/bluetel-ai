import { cn } from '@sisyphus-admin/lib/cn'

interface StateLedProps {
  /**
   * Whether the lamp pulses. The pulse is the system's one looping animation and it only ever means
   * "working" — so this is never a decorative choice; it comes from
   * `presentationForState(state).pulse`.
   */
  pulse?: boolean
}

/**
 * The indicator lamp: a 6px square in `currentColor` with a 1px radius.
 *
 * Square, because a round dot reads as a bullet and a square reads as an indicator lamp. It takes
 * its colour from the chip around it rather than from a prop, which is why a chip cannot end up
 * with a lamp that disagrees with its border or its readout.
 *
 * Decorative to assistive technology: the readout beside it already says the state in words, and a
 * second announcement would be noise.
 */
export const StateLed = ({ pulse = false }: StateLedProps) => (
  <span
    aria-hidden="true"
    data-pulse={pulse}
    className={cn(
      'h-led w-led rounded-led block shrink-0 bg-current',
      pulse && 'animate-led-pulse',
    )}
  />
)
