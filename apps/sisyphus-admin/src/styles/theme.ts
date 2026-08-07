import type { Config } from 'tailwindcss'

/**
 * The Tailwind theme, expressed entirely as references to the CSS variables declared in
 * `globals.css` (T073, FR-021).
 *
 * It lives in `src/` rather than inside `tailwind.config.ts` for one reason: a config file is not
 * a module anything can test, and the properties that matter here are structural rather than
 * cosmetic. `theme.test.ts` asserts them — every colour resolves to a variable, no component-facing
 * key names a `-dark` twin, the spacing scale is exactly the eight named steps, and there is no
 * `full` radius for a pill to be built out of.
 *
 * The scales below **replace** their Tailwind defaults rather than extending them. That is the
 * mechanism behind SC-015: `text-red-500`, `p-4`, `text-sm` and `rounded-full` do not exist, so a
 * literal cannot be smuggled into a component through a utility class that happens to be nearby.
 */

/** Colour tokens. Component-facing names only — the theme layer selects light or dark, never a component. */
const colors = {
  transparent: 'transparent',
  current: 'currentColor',
  inherit: 'inherit',
  signal: 'var(--color-signal)',
  'signal-deep': 'var(--color-signal-deep)',
  'signal-wash': 'var(--color-signal-wash)',
  ink: 'var(--color-ink)',
  graphite: 'var(--color-graphite)',
  sheet: 'var(--color-sheet)',
  paper: 'var(--color-paper)',
  'paper-2': 'var(--color-paper-2)',
  hairline: 'var(--color-hairline)',
  'hairline-hi': 'var(--color-hairline-hi)',
  amber: 'var(--color-amber)',
  verdigris: 'var(--color-verdigris)',
  rust: 'var(--color-rust)',
  'on-signal': 'var(--color-on-signal)',
  keycap: 'var(--color-keycap)',
} as const

/** The eight named steps, plus zero. Named steps beat a numeric scale because the names carry intent. */
const spacing = {
  0: '0px',
  hair: 'var(--space-hair)',
  tight: 'var(--space-tight)',
  close: 'var(--space-close)',
  default: 'var(--space-default)',
  section: 'var(--space-section)',
  band: 'var(--space-band)',
  gutter: 'var(--space-gutter)',
} as const

/** What a type token carries besides its size. */
interface TypeTokenConfig {
  lineHeight: string
  letterSpacing?: string
  fontWeight: string
}

/** Tailwind's two-part font-size entry: the size, then everything that travels with it. */
type TypeToken = [size: string, config: TypeTokenConfig]

/**
 * The seven typography tokens. Each carries its line height, tracking and weight, so the only thing
 * a primitive has to pair it with is the family — which is what the `.type-*` classes in
 * `globals.css` do.
 */
const fontSize = {
  display: [
    'var(--type-display-size)',
    {
      lineHeight: 'var(--type-display-height)',
      letterSpacing: 'var(--type-display-tracking)',
      fontWeight: 'var(--type-display-weight)',
    },
  ],
  heading: [
    'var(--type-heading-size)',
    {
      lineHeight: 'var(--type-heading-height)',
      letterSpacing: 'var(--type-heading-tracking)',
      fontWeight: 'var(--type-heading-weight)',
    },
  ],
  body: [
    'var(--type-body-size)',
    {
      lineHeight: 'var(--type-body-height)',
      letterSpacing: 'var(--type-body-tracking)',
      fontWeight: 'var(--type-body-weight)',
    },
  ],
  'label-mono': [
    'var(--type-label-mono-size)',
    {
      lineHeight: 'var(--type-label-mono-height)',
      letterSpacing: 'var(--type-label-mono-tracking)',
      fontWeight: 'var(--type-label-mono-weight)',
    },
  ],
  'data-mono': [
    'var(--type-data-mono-size)',
    {
      lineHeight: 'var(--type-data-mono-height)',
      letterSpacing: 'var(--type-data-mono-tracking)',
      fontWeight: 'var(--type-data-mono-weight)',
    },
  ],
  'label-button': [
    'var(--type-label-button-size)',
    {
      lineHeight: 'var(--type-label-button-height)',
      letterSpacing: 'var(--type-label-button-tracking)',
      fontWeight: 'var(--type-label-button-weight)',
    },
  ],
  code: [
    'var(--type-code-size)',
    {
      lineHeight: 'var(--type-code-height)',
      fontWeight: 'var(--type-code-weight)',
    },
  ],
} satisfies Record<string, TypeToken>

/**
 * Instruments have small radii. `full` is absent on purpose: FR-027 says nothing is a pill, and the
 * cheapest way to enforce that is for the utility not to exist.
 */
const borderRadius = {
  none: '0px',
  DEFAULT: 'var(--radius-sm)',
  sm: 'var(--radius-sm)',
  md: 'var(--radius-md)',
  lg: 'var(--radius-lg)',
  chip: 'var(--radius-chip)',
  led: 'var(--radius-led)',
} as const

/** Uniformly 1px. The variation is in the colour, so the width scale has one entry. */
const borderWidth = {
  0: '0px',
  DEFAULT: 'var(--border-hairline-width)',
} as const

/**
 * Shadows. `raised` is the one elevation step, reserved for menus, popovers and modals — so a
 * shadow on this page means "temporary". The `keycap` shadows are not elevation at all: they are
 * the inset bottom shade that gives a button travel.
 */
const boxShadow = {
  none: 'none',
  raised: 'var(--shadow-raised)',
  keycap: 'inset 0 calc(-1 * var(--keycap-depth)) 0 0 var(--color-keycap)',
  'keycap-pressed': 'inset 0 calc(-1 * var(--keycap-depth-pressed)) 0 0 var(--color-keycap)',
  'keycap-hairline': 'inset 0 calc(-1 * var(--keycap-depth)) 0 0 var(--color-hairline)',
  'keycap-hairline-pressed':
    'inset 0 calc(-1 * var(--keycap-depth-pressed)) 0 0 var(--color-hairline)',
} as const

export const sisyphusTheme = {
  colors,
  spacing,
  fontSize,
  borderRadius,
  borderWidth,
  boxShadow,
  extend: {
    fontFamily: {
      sans: 'var(--font-family-sans)',
      mono: 'var(--font-family-mono)',
    },
    /** `border` on its own paints the structural hairline rather than `currentColor`. */
    borderColor: {
      DEFAULT: 'var(--color-hairline)',
    },
    /** The field's focus ring: 2px of `signal-wash` outside a `signal` border. */
    ringWidth: {
      DEFAULT: 'var(--field-focus-ring-width)',
    },
    maxWidth: {
      column: 'var(--space-max-width)',
      prose: 'var(--measure-prose)',
    },
    /** Instrument dimensions, kept out of `spacing` so the eight named steps stay eight. */
    width: {
      led: 'var(--size-led)',
    },
    height: {
      led: 'var(--size-led)',
      meter: 'var(--size-meter-track)',
    },
    /** A key with travel: 1px down on press. */
    translate: {
      press: 'var(--press-travel)',
    },
    transitionDuration: {
      state: 'var(--motion-state)',
      press: 'var(--motion-press)',
    },
    transitionTimingFunction: {
      panel: 'var(--ease-panel)',
    },
    keyframes: {
      'led-pulse': {
        '0%, 100%': { opacity: '1' },
        '50%': { opacity: '0.4' },
      },
    },
    /** The only looping animation in the system. It means "working". */
    animation: {
      'led-pulse': 'led-pulse var(--motion-pulse) var(--ease-panel) infinite',
    },
  },
} as const satisfies Config['theme']

/** Sources Tailwind scans for class names. */
export const SISYPHUS_CONTENT_GLOBS = ['./src/**/*.{ts,tsx}'] as const
