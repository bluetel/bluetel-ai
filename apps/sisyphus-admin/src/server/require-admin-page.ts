import type { SisyphusSessionUser } from '@sisyphus-admin/lib/auth'
import { auth } from '@sisyphus-admin/lib/auth'
import { notFound, redirect } from 'next/navigation'

import { decideAdminPageAccess, SIGN_IN_PATH } from './admin-page-access'

/**
 * The gate every admin page opens with (FR-169).
 *
 * `redirect` and `notFound` are declared `never` and work by throwing, so a page that calls this
 * and is not entitled to render **stops here** — the JSX below the call is never evaluated, no
 * query is mounted and no markup is produced. That is the difference between a gate and a hide.
 *
 * @returns The signed-in admin, so a page that needs to know who is acting does not resolve the
 *   session a second time.
 */
export const requireAdminPage = async (): Promise<SisyphusSessionUser> => {
  const access = decideAdminPageAccess((await auth())?.user)

  if (access.kind === 'sign-in') redirect(SIGN_IN_PATH)
  if (access.kind === 'not-found') notFound()

  return access.user
}
