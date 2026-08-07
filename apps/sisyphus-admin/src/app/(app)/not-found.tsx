import { NotFoundCard } from '@sisyphus-admin/components/admin'
import { RouteBack } from '@sisyphus-admin/components/boundary'
import { PageHeader } from '@sisyphus-admin/components/shell'

/**
 * The not-found boundary **inside** the shell (T153, FR-197, FR-190).
 *
 * ## Why this file exists as well as `src/app/not-found.tsx`
 *
 * Next.js renders a `notFound()` in the nearest `not-found.tsx` **above the segment that threw**,
 * inside that boundary's own layout chain. `(app)` is a route group and route groups are segments
 * for this purpose, so a boundary placed here renders as a child of `src/app/(app)/layout.tsx` —
 * with the sidebar, the top bar, the skip link and the page column already around it. A boundary
 * only at the root would render as a child of `src/app/layout.tsx`, which is `<html><body>` and two
 * fonts: styled card, no console around it, and no nav to leave by.
 *
 * That distinction is the whole of FR-197's "inside the application shell", and it is not a detail:
 * the throw this catches is `requireAdminPage()`, which every one of the six admin screens opens
 * with. An engineer who follows a link to `/admin/users` should land on a screen that says there is
 * no such thing **and still be in the panel**, one click from everything they can actually open.
 *
 * ## What it must not say
 *
 * Not "you do not have permission". `requireAdminPage` chose `notFound` over `forbidden` precisely
 * so an out-of-role caller cannot tell a screen they may not have from one that does not exist
 * (FR-190), and a boundary that explained the difference would hand back the disclosure the throw
 * was chosen to prevent. So it reuses `NotFoundCard` — the same component the panels render for a
 * tRPC `NOT_FOUND`, with the same idle graphite chip and no variant that mentions permission.
 *
 * It is a server component. `not-found.tsx` has no props and no interactivity, and the route back
 * is a link.
 */
const AppNotFound = () => (
  <>
    <PageHeader
      eyebrow="Not found"
      title="No such screen"
      summary="The address you asked for does not resolve to anything you can open. That is the same answer the panel gives for a screen that does not exist and for one that is not yours, deliberately — it will not tell you which."
    />
    <NotFoundCard message="No such screen." />
    <RouteBack />
  </>
)

export default AppNotFound
