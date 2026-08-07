import { NotFoundCard } from '@sisyphus-admin/components/admin'
import { BoundaryScreen, RouteBack } from '@sisyphus-admin/components/boundary'
import { PageHeader } from '@sisyphus-admin/components/shell'

/**
 * The root not-found boundary (T153, FR-197).
 *
 * ## What reaches this one rather than `(app)/not-found.tsx`
 *
 * Two things, and neither can be caught inside the group:
 *
 * 1. **A URL that matches no route at all** — `/whatever`. There is no `(app)` segment in that
 *    request, so its layout never runs and its boundary is not in the chain.
 * 2. **The group layout's own `notFound()`.** `src/app/(app)/layout.tsx` throws it for a session
 *    that exists but is not active. A boundary cannot render inside the layout that threw — the
 *    layout is the thing that failed — so it bubbles past `(app)` to here. That is exactly the case
 *    where rendering the shell would be wrong anyway: the sidebar takes a role from a session the
 *    layout has just refused to accept.
 *
 * So this one renders **without** the shell, on purpose, and it is not a fallback for the one
 * inside the group — the two catch different throws. See `src/app/(app)/not-found.tsx` for why the
 * in-group boundary exists and what lands there.
 *
 * ## Why it still is not the framework default
 *
 * `BoundaryScreen` opens the `<main>` landmark and sets the same page column the shell would have,
 * the card is the panel's own `NotFoundCard`, and there is a route back. What is missing is the nav
 * — which the caller may not be entitled to — not the design system.
 *
 * `/workflows` is a safe destination for a caller with no session and for a deactivated one alike:
 * the group layout redirects the first to sign in, and sign-in refuses the second with a readable
 * reason rather than looping (FR-195).
 */
const RootNotFound = () => (
  <BoundaryScreen>
    <PageHeader
      eyebrow="Not found"
      title="No such screen"
      summary="The address you asked for does not resolve to anything in this panel. If you were signed in a moment ago, your session may no longer be an active one."
    />
    <NotFoundCard message="No such screen." />
    <RouteBack />
  </BoundaryScreen>
)

export default RootNotFound
