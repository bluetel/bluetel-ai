import { cva, type VariantProps } from 'class-variance-authority'

import { FOCUS_RING } from './focus-ring'

/**
 * The four button variants (FR-029).
 *
 * The shared idea is a panel key: a `2px` inset bottom shade that compresses to `1px` and drops the
 * key `1px` on press. That is the whole of the depth story — **no hover lift, no glow, no gradient
 * fill**, because those read as consumer SaaS and undermine the claim the rest of the console is
 * making. Hover changes fill or border colour and nothing else.
 *
 * `enabled:` guards every hover and press treatment, so a disabled key stays flat and unmoved rather
 * than inviting a press it will not answer.
 */
export const buttonVariants = cva(
  [
    'type-label-button',
    'inline-flex items-center justify-center gap-tight',
    'rounded-sm p-close',
    'border border-transparent',
    'transition-[background-color,border-color,box-shadow,color,transform]',
    'duration-state ease-panel',
    'enabled:active:duration-press enabled:active:translate-y-press',
    'disabled:cursor-not-allowed disabled:shadow-none',
    FOCUS_RING,
  ],
  {
    variants: {
      variant: {
        primary: [
          'bg-signal text-on-signal shadow-keycap',
          'enabled:hover:bg-signal-deep enabled:active:bg-signal-deep',
          'enabled:active:shadow-keycap-pressed',
          'disabled:bg-hairline disabled:text-graphite',
        ],
        secondary: [
          'bg-paper text-ink border-hairline-hi shadow-keycap-hairline',
          'enabled:hover:bg-paper-2 enabled:hover:border-ink',
          'enabled:active:shadow-keycap-hairline-pressed',
          'disabled:text-graphite disabled:border-hairline',
        ],
        quiet: [
          'text-graphite',
          'enabled:hover:bg-signal-wash enabled:hover:text-ink',
          'disabled:text-graphite',
        ],
        danger: [
          'text-rust border-rust',
          'enabled:hover:bg-rust enabled:hover:text-paper',
          'disabled:text-graphite disabled:border-hairline',
        ],
      },
    },
    defaultVariants: {
      /**
       * Secondary, not primary. DESIGN.md allows one primary per view, so the variant a caller gets
       * by forgetting to choose must be the one it is always safe to have two of.
       */
      variant: 'secondary',
    },
  },
)

export type ButtonVariantProps = VariantProps<typeof buttonVariants>

/** The four names a caller may pass. There is no fifth, and no escape hatch to a colour. */
export type ButtonVariant = NonNullable<ButtonVariantProps['variant']>
