import { auth, isActiveSessionUser } from '@sisyphus-admin/lib/auth'
import { SIGN_IN_PATH } from '@sisyphus-admin/server'
import { redirect } from 'next/navigation'

import { DEFAULT_REDIRECT_TARGET } from './sign-in'

/**
 * `/` — a signpost, never a destination (T148, FR-196).
 *
 * It replaces a stub that rendered `<h1>Sisyphus</h1>` and offered no way anywhere, which made the
 * panel's origin the one URL in the product that did nothing. There is no content here on purpose:
 * the root of an operator console is a question about who is asking, and the answer is always
 * another route.
 *
 * ## The two destinations, and the third case
 *
 * An **active** session goes to the fleet list — the same screen a completed sign-in lands on, and
 * the constant is imported from there rather than restated so the two cannot drift apart. Nobody at
 * all goes to sign in.
 *
 * The third case is a session held by a user who has since been deactivated. `isActiveSessionUser`
 * puts them with the signed-out rather than with the signed-in, because the alternative is worse in
 * both directions: `/workflows` would render a shell around queries that are all going to refuse
 * them, and the deactivation would look like a broken panel instead of a decision. This differs
 * from `decideAdminPageAccess`, which answers `not-found` for the same user — deliberately, because
 * that gate is protecting a *resource* whose existence must not be confirmed (FR-190), and `/`
 * conceals nothing. Sign-in is not a dead end for them either: it will refuse them, with a reason
 * (see `./sign-in/error-reason.ts`).
 *
 * `redirect` is declared `never` and works by throwing, so this component returns nothing and
 * renders nothing. Dynamic, because the answer is a function of the caller's session.
 */
export const dynamic = 'force-dynamic'

const RootPage = async (): Promise<never> => {
  const user = (await auth())?.user

  redirect(isActiveSessionUser(user) ? DEFAULT_REDIRECT_TARGET : SIGN_IN_PATH)
}

export default RootPage
