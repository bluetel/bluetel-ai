'use client'

import { BoundaryScreen, ErrorCard, RouteBack } from '@sisyphus-admin/components/boundary'
import { PageHeader } from '@sisyphus-admin/components/shell'

/**
 * The root error boundary (T154, FR-197, FR-031).
 *
 * ## What reaches this one rather than `(app)/error.tsx`
 *
 * Anything that throws where the shell is not, or is not yet:
 *
 * 1. **The sign-in screen and the root redirect**, which sit outside `(app)` by design — the one
 *    screen a signed-out visitor may render, and the signpost that sends them to it.
 * 2. **`src/app/(app)/layout.tsx` itself.** A boundary cannot render inside the layout that threw,
 *    so a failure while resolving the session bubbles past the group. Rendering the shell here
 *    would mean asking for a session that has just failed to resolve, which is how a boundary
 *    throws while reporting a throw.
 *
 * So the shell is absent on purpose and this is not a fallback for the in-group boundary — the two
 * catch different throws. What is present is the design system: `BoundaryScreen` opens the `<main>`
 * landmark and the page column, the card is the same `ErrorCard`, and the code, the digest and the
 * next action are the same three things (FR-031).
 *
 * ## Not `global-error.tsx`
 *
 * That file replaces the root layout, including `<html>` and `<body>`, and therefore also the two
 * font variables and the token layer — it would be styled by nothing. It is the boundary for the
 * root layout itself failing, which here is `<html><body>{children}</body></html>` and two Google
 * font loads. This boundary covers everything below that, which is everything with any logic in it.
 */
const RootError = ({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string }
  readonly reset: () => void
}) => (
  <BoundaryScreen>
    <PageHeader
      eyebrow="Error"
      title="This screen did not render"
      summary="Something threw while this screen was being drawn, before the console around it had been established. Nothing has been written or changed."
    />
    <ErrorCard error={error} onRetry={reset} />
    <RouteBack />
  </BoundaryScreen>
)

export default RootError
