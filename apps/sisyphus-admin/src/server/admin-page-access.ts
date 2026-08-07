import type { SisyphusSessionUser } from '@sisyphus-admin/lib/auth'
import { isAdminSessionUser } from '@sisyphus-admin/lib/auth'

/**
 * Who may render an admin page, decided as a pure function (FR-169).
 *
 * All configuration is admin-only, and the panel enforces that **on the server**: an admin page is
 * a server component that resolves the session, asks this, and renders nothing when the answer is
 * no. A client-side hide would still have shipped the page, still have mounted its queries and
 * still have let a determined non-admin read the markup — the refusal has to be the reason the
 * page produced no output, not a style applied to output that exists.
 *
 * ## Why a non-admin gets `not-found` rather than `forbidden`
 *
 * The same reason every out-of-scope read in this platform is `NOT_FOUND` (FR-190): a "you do not
 * have permission to view this" page confirms that the thing exists. For `/admin/users` that
 * matters little; for `/admin/profiles/{id}/access` it is the whole rule, because the id in the
 * URL is the caller's guess and a `FORBIDDEN` would tell them the guess was right. One decision
 * for every admin page means no page has to remember which case it is.
 *
 * A caller with no session at all is sent to sign in instead — they have not been refused, they
 * have not been asked yet, and answering 404 would strand an admin who simply arrived logged out.
 */

/** Auth.js's configured sign-in page. Kept beside the decision that redirects to it. */
export const SIGN_IN_PATH = '/sign-in'

/** What a page should do with the caller. */
export type AdminPageAccess =
  | { readonly kind: 'render'; readonly user: SisyphusSessionUser }
  | { readonly kind: 'sign-in' }
  | { readonly kind: 'not-found' }

/**
 * Decide whether an admin page may render.
 *
 * @param user - The session user, or `undefined` when there is no session.
 * @returns `render` with the caller for an active admin; `sign-in` for nobody; `not-found` for
 *   everyone else, including a deactivated admin — whose session must not be treated as an
 *   invitation to sign in again, because sign-in would refuse them too (FR-175, FR-176).
 */
export const decideAdminPageAccess = (user: SisyphusSessionUser | undefined): AdminPageAccess => {
  if (user === undefined) return { kind: 'sign-in' }
  // `isAdminSessionUser` is active-and-admin in one call, so a deactivated admin lands here too.
  if (!isAdminSessionUser(user)) return { kind: 'not-found' }
  return { kind: 'render', user }
}
