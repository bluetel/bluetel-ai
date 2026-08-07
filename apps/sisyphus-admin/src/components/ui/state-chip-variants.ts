import { cva, type VariantProps } from 'class-variance-authority'

import type { StateTone } from './workflow-state-presentation'

/**
 * One class per tone, and the tone set is closed.
 *
 * `satisfies Record<StateTone, string>` is the second half of the guarantee in
 * `workflow-state-presentation.ts`: a tone added there without a class here fails `tsc`, so the two
 * halves of the mapping cannot drift apart.
 *
 * A tone sets `color` and nothing else. The chip's border is `currentColor` and its LED is
 * `bg-current`, so one declaration colours all three — which is why there is no way for the border
 * to end up saying something different from the lamp.
 */
const toneClasses = {
  signal: 'text-signal',
  amber: 'text-amber',
  verdigris: 'text-verdigris',
  rust: 'text-rust',
  graphite: 'text-graphite',
} satisfies Record<StateTone, string>

/**
 * The signature element's class set (FR-030): a 1px `currentColor` border on `paper`, radius 2px,
 * hair-width inner padding, and a `label-mono` readout a `tight` step away from the LED.
 */
export const stateChipVariants = cva(
  [
    'inline-flex items-center gap-tight',
    'rounded-chip border border-current bg-paper p-hair',
    'type-label-mono',
  ],
  {
    variants: {
      tone: toneClasses,
    },
    defaultVariants: {
      /** Graphite is the idle case — the one palette colour not locked to a machine state. */
      tone: 'graphite',
    },
  },
)

export type StateChipVariantProps = VariantProps<typeof stateChipVariants>
