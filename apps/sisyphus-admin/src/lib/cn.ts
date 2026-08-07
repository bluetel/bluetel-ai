import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * The one class-composition utility for the panel (FR-033).
 *
 * `clsx` resolves conditionals and arrays into a class string; the merge step then drops earlier
 * Tailwind utilities that a later one overrides, so a caller's `p-default` beats a base `p-close`
 * regardless of the order the classes were assembled in. Without the merge, `cva` variants and
 * caller-supplied `className` overrides would both land in the class list and the winner would be
 * decided by stylesheet order rather than by call order — which is the bug this utility exists to
 * prevent.
 *
 * ## Why stock `twMerge` was not enough
 *
 * `tailwind-merge` groups utilities by the **values** it knows about, and the values it ships with
 * are Tailwind's defaults — a numeric spacing scale and a `full` radius. The panel's theme
 * (`src/styles/theme.ts`) *replaces* both scales with named steps, so out of the box
 * `cn('p-close', 'p-default')` returned **both** classes: neither `close` nor `default` looks like
 * a spacing value to the merger, so it could not tell they conflict. The override quietly stopped
 * winning, and that failure is invisible until something renders at the wrong size.
 *
 * {@link NAMED_SPACING} and {@link NAMED_RADII} teach it the two scales, which restores the
 * guarantee for every utility built on them — `p-*`, `px-*`, `m-*`, `gap-*`, `space-*`, `rounded-*`
 * and the rest. Colours needed no such teaching: `tailwind-merge` matches an unrecognised colour
 * name by shape, which is why `border-ink` already displaced `border-hairline-hi`.
 *
 * Every component composes classes through this function. A second merge helper anywhere in the
 * panel is a duplicate the qlty gate will flag.
 */

/**
 * The spacing scale's names, from `DESIGN.md` → Layout: the eight named steps, plus zero.
 *
 * Restated here rather than imported from `src/styles/theme.ts` so the Tailwind config does not
 * become a runtime dependency of every client component that composes a class name. The colocated
 * test asserts the two lists agree, so a step added to the theme and forgotten here fails there
 * rather than at a call site.
 */
export const NAMED_SPACING = [
  '0',
  'hair',
  'tight',
  'close',
  'default',
  'section',
  'band',
  'gutter',
] as const

/**
 * The radius scale's names, from `DESIGN.md` → Shapes: `sm`/`md`/`lg`, plus the two instrument
 * radii the state chip declares. There is no `full`, because nothing in this system is a pill.
 */
export const NAMED_RADII = ['none', 'sm', 'md', 'lg', 'chip', 'led'] as const

const merge = extendTailwindMerge({
  extend: {
    theme: {
      spacing: [...NAMED_SPACING],
      radius: [...NAMED_RADII],
    },
  },
})

export const cn = (...inputs: ClassValue[]): string => merge(clsx(inputs))
