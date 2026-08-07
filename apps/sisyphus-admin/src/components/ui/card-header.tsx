import { cn } from '@sisyphus-admin/lib/cn'
import type { HTMLAttributes } from 'react'

/**
 * The card's tinted header strip: `paper-2` above a 1px hairline, set in `label-mono`.
 *
 * Laid out as a row with space between, because the thing that most often sits at the right-hand
 * end of a card header is a state chip.
 */
export const CardHeader = ({ className, ...rest }: HTMLAttributes<HTMLElement>) => (
  <header
    {...rest}
    className={cn(
      'gap-close flex items-center justify-between',
      'border-hairline bg-paper-2 p-close border-b',
      'type-label-mono text-ink',
      className,
    )}
  />
)
