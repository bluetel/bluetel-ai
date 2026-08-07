/**
 * The route-level not-found and error boundaries' furniture (T153, T154, FR-197).
 *
 * Four route files use these — `src/app/not-found.tsx`, `src/app/error.tsx`,
 * `src/app/(app)/not-found.tsx` and `src/app/(app)/error.tsx` — and the reason there are four is in
 * each file's own comment. What is shared is the wording, the way out and the code an unhandled
 * render error reports under, because a boundary that said something different depending on which
 * of the four caught it would be four boundaries rather than one behaviour.
 *
 * The not-found *card* is not here: it is `@sisyphus-admin/components/admin`'s `NotFoundCard`, and
 * it is the same component the panels use for a tRPC `NOT_FOUND`. A second one would be a second
 * place the FR-190 wording had to be got right.
 */

export { describeBoundaryError, BOUNDARY_ERROR_CODE, NO_DIGEST } from './boundary-error'
export type { BoundaryErrorReadouts } from './boundary-error'

export { BoundaryScreen } from './boundary-screen'

export { ErrorCard } from './error-card'

export { ROUTE_BACK_HREF, RouteBack } from './route-back'
