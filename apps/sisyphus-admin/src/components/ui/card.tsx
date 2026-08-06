import { cn } from '@sisyphus-admin/lib/cn'
import type { HTMLAttributes } from 'react'

/**
 * A card is a lighter plane inside a 1px hairline — border-led, not shadow-led (FR-028).
 *
 * It carries no shadow, and adding one would not be a styling choice: `raised` is the system's only
 * elevation step and it means "temporary". The moment a card floats, a shadow stops being
 * information.
 *
 * `overflow-hidden` so the tinted header strip is clipped by the container radius rather than
 * needing its own.
 */
export const Card = ({ className, ...rest }: HTMLAttributes<HTMLElement>) => (
  <section
    {...rest}
    className={cn('border-hairline bg-paper text-ink overflow-hidden rounded-md border', className)}
  />
)
