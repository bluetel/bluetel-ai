import { FOCUS_RING } from '@sisyphus-admin/components/ui'
import { cn } from '@sisyphus-admin/lib/cn'
import Link from 'next/link'

/** Where a boundary sends someone who has nowhere else to go. The fleet list is every role's home. */
export const ROUTE_BACK_HREF = '/workflows'

interface RouteBackProps {
  /** Overridden only where a nearer route back exists than the fleet list. */
  readonly href?: string
  readonly label?: string
}

/**
 * The way out of a boundary screen (FR-197).
 *
 * A not-found or an error screen without one is the dead end the requirement exists to forbid: the
 * back button is the browser's affordance, not the product's, and it puts the operator back on the
 * URL that just refused them.
 *
 * `/workflows` rather than `/`, even though `/` would redirect there, because a link should say
 * where it goes. It is the right destination for every role — an engineer and an admin both have
 * it, so the route back never lands on a second refusal — and a signed-out visitor who follows it
 * is redirected to sign in rather than to another 404 (FR-195, FR-196).
 *
 * It is a `<nav>` so a screen reader can find it without reading the card above it, and it composes
 * {@link FOCUS_RING} because it is very often the only focusable thing on the page.
 */
export const RouteBack = ({
  href = ROUTE_BACK_HREF,
  label = 'Back to the workflow list',
}: RouteBackProps) => (
  <nav aria-label="Route back">
    <Link
      href={href}
      className={cn(
        'type-label-button text-signal',
        'underline-offset-4 hover:underline',
        FOCUS_RING,
      )}
    >
      {label}
    </Link>
  </nav>
)
