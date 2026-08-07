'use client'

import { ErrorCard, RouteBack } from '@sisyphus-admin/components/boundary'
import { PageHeader } from '@sisyphus-admin/components/shell'

/**
 * The error boundary **inside** the shell (T154, FR-197, FR-031).
 *
 * ## Why it is here and not only at the root
 *
 * React renders an error boundary in place of the segment that threw, as a child of that segment's
 * layout. Placed here, it replaces the failed **screen** and leaves `src/app/(app)/layout.tsx`
 * mounted around it: sidebar, top bar, skip link, page column. Placed only at the root, it would
 * replace everything the root layout wraps — the shell included — so one screen throwing would take
 * the whole console down to report it. Same placement reasoning as `./not-found.tsx`, same
 * conclusion, different mechanism.
 *
 * The layout above it is a server component that has already resolved the session by the time any
 * child can throw, so the nav around this boundary is the caller's real nav, not a stale one.
 *
 * ## It has to be a client component
 *
 * Next.js requires it: an `error.tsx` receives `reset`, which is a function, and it re-renders on
 * the client. That is also the reason this file holds no data of its own — a boundary that read
 * anything could throw while reporting a throw, and then there is nothing left to catch it.
 *
 * ## A code and a next action, not an apology
 *
 * FR-031 applies to this screen as much as to a field: the operator gets `E_SCREEN_FAILED`, the
 * server's digest to quote, a `Try again` that re-runs the render, and a route back that is not
 * their browser's back button. What they do not get is `error.message` — see
 * `components/boundary/boundary-error.ts` for why printing it would be both useless and unsafe.
 */
const AppError = ({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string }
  readonly reset: () => void
}) => (
  <>
    <PageHeader
      eyebrow="Error"
      title="This screen did not render"
      summary="Something on this screen threw while it was being drawn. The rest of the console is unaffected — the nav beside this message still works, and nothing has been written or changed."
    />
    <ErrorCard error={error} onRetry={reset} />
    <RouteBack />
  </>
)

export default AppError
