import { cva, type VariantProps } from 'class-variance-authority'

/**
 * The text control: `paper` inside a `hairline-hi` border at the instrument radius.
 *
 * Focus is a `signal` border plus a 2px `signal-wash` ring — the border says "here" and the wash
 * says "and this much of the page belongs to it". That is the field's own focus treatment, declared
 * as `field-control-focus` in DESIGN.md, which is why the shared `focus-ring` outline is **not**
 * composed in here: the more specific component declaration wins, and two concentric rings on one
 * input is noise. The user agent's default outline is suppressed so the two cannot both appear.
 *
 * The invalid variant swaps the border for `rust` in every state, so an error is visible before the
 * field is touched and stays visible while it is being fixed.
 */
export const fieldControlVariants = cva(
  [
    'type-body w-full',
    'bg-paper text-ink placeholder:text-graphite',
    'rounded-sm p-close border border-hairline-hi',
    'transition-[border-color,box-shadow] duration-state ease-panel',
    'hover:border-ink',
    'focus:outline-none focus:border-signal focus:ring focus:ring-signal-wash',
    'disabled:cursor-not-allowed disabled:bg-paper-2 disabled:text-graphite',
  ],
  {
    variants: {
      invalid: {
        true: 'border-rust hover:border-rust focus:border-rust',
        false: '',
      },
    },
    defaultVariants: {
      invalid: false,
    },
  },
)

export type FieldControlVariantProps = VariantProps<typeof fieldControlVariants>
