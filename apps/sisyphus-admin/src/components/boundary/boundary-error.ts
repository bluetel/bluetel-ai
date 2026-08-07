import type { FieldErrorContent } from '@sisyphus-admin/components/ui'

/**
 * What an error boundary is allowed to say (FR-197, FR-031).
 *
 * ## Why the caught error's message is never shown
 *
 * The value React hands an error boundary is whatever was thrown while rendering, and on the server
 * side of a Next.js render that is deliberately redacted before it reaches the browser — the client
 * receives a generic error carrying only a `digest`. Rendering `error.message` would therefore print
 * "An error occurred in the Server Components render" to an operator, which is a dead end wearing
 * the costume of a diagnosis. Worse, in the one case where a real message *does* survive — a client
 * render throwing — it may carry an identifier the caller was never entitled to see, which is the
 * disclosure FR-190 spends the whole API surface avoiding.
 *
 * So the panel says the same two things every time: a **code**, which is stable and searchable, and
 * a **next action**, which is what FR-031 requires of every error in this system. The digest is the
 * one thing worth passing on, because it is the value that ties the screen the operator was looking
 * at to the line in the server log — and it is an opaque hash, so it discloses nothing.
 */

/** The code an unhandled render error reports under. One value, so it is worth searching for. */
export const BOUNDARY_ERROR_CODE = 'E_SCREEN_FAILED'

/** What the digest readout says when the runtime did not record one — a client-side throw. */
export const NO_DIGEST = 'none recorded'

export interface BoundaryErrorReadouts {
  /** The code and the next action, in the shape `FieldError` requires. */
  readonly content: FieldErrorContent
  /** The server's log correlation hash, or {@link NO_DIGEST}. */
  readonly digest: string
}

/**
 * Describe a caught render error.
 *
 * @param error - Whatever the boundary was handed. Typed loosely on purpose: a boundary that
 *   narrowed its input would be a boundary that could throw while reporting a throw.
 * @returns A code, a next action, and the digest to quote. Never a dead end and never a raw message.
 */
export const describeBoundaryError = (error?: {
  readonly digest?: string
}): BoundaryErrorReadouts => {
  const digest = error?.digest

  return {
    content: {
      code: BOUNDARY_ERROR_CODE,
      action:
        'Try the screen again. If it fails a second time, open the workflow list and quote this code and digest to the platform team.',
    },
    digest: digest === undefined || digest === '' ? NO_DIGEST : digest,
  }
}
