import { auth, isActiveSessionUser } from '@sisyphus-admin/lib/auth'
import { SIGN_IN_PATH } from '@sisyphus-admin/server'
import { notFound, redirect } from 'next/navigation'
import type { ReactNode } from 'react'

/**
 * The gate for `/workflows` (FR-011, FR-175).
 *
 * ## Why this is not `requireAdminPage`
 *
 * The fleet list is not administration. Every engineer sees the runs they own or have been granted
 * a profile for, so the gate here is **an active session**, not the admin role — gating on admin
 * would make the product's primary screen invisible to the people it is for. What keeps a
 * non-admin from seeing somebody else's runs is not this layout: it is `scopedProcedure`, which
 * composes the FR-190 base selector into every workflow read. A page-level check could only ever
 * be a second, weaker copy of that rule.
 *
 * ## Two outcomes, and they are different outcomes
 *
 * A caller with **no session** is redirected to sign in: they have not been refused, they have not
 * been asked yet, and answering 404 would strand somebody who simply arrived logged out.
 *
 * A caller whose session exists but is **not active** — a deactivated user whose cookie has not
 * expired — gets `notFound`. Not a redirect, because sign-in would refuse them too and the loop is
 * worse than the dead end; and not `FORBIDDEN`, for the same reason every out-of-scope read in
 * this platform is `NOT_FOUND` (FR-190).
 *
 * `redirect` and `notFound` are declared `never` and work by throwing, so a caller who is not
 * entitled stops here: no markup, no queries mounted, nothing in the response to read. That is the
 * difference between a gate and a hide.
 */
const WorkflowsLayout = async ({ children }: { children: ReactNode }) => {
  const user = (await auth())?.user

  if (user === undefined) redirect(SIGN_IN_PATH)
  if (!isActiveSessionUser(user)) notFound()

  return children
}

export default WorkflowsLayout
