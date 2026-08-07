import { requireAdminPage } from '@sisyphus-admin/server'
import type { ReactNode } from 'react'

/**
 * The admin gate for `/admin/bundles` (FR-167, FR-169).
 *
 * A layout rather than a check inside the page, because `page.tsx` is a client component: the
 * refusal has to happen on the server, before any markup is produced, and a client component
 * cannot do that. `requireAdminPage` throws — `redirect` for a caller with no session, `notFound`
 * for everyone else — so a non-admin never receives the page rather than receiving a hidden one.
 *
 * `not-found` rather than `forbidden` is deliberate and is decided once, in
 * `@sisyphus-admin/server`: a permission page confirms that what is behind it exists (FR-190).
 *
 * This is the second of the two gates on registering a bundle. The first is on the upload action
 * itself, which re-checks the session because a server action is its own request and a gate on the
 * page that rendered the form does not cover the call the form makes.
 */
const BundlesLayout = async ({ children }: { children: ReactNode }) => {
  await requireAdminPage()
  return children
}

export default BundlesLayout
