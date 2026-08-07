import { UsersPanel } from '@sisyphus-admin/components/admin/users'
import { PageHeader } from '@sisyphus-admin/components/shell'
import { requireAdminPage } from '@sisyphus-admin/server'

/**
 * `/admin/users` — the admin-only user management surface (T039, FR-171).
 *
 * **The gate is why this page renders nothing for a non-admin, not a style applied to output that
 * exists.** `requireAdminPage` resolves the session on the server and throws Next.js's `notFound`
 * for anyone who is not an active admin, so the JSX below is never evaluated: no markup, no
 * queries mounted, nothing to read in the response. A client-side hide would have shipped all
 * three.
 *
 * Dynamic, because the page is a function of the caller's session. Rendering it once at build time
 * would produce a page whose access decision was made for whoever the build was.
 */
export const dynamic = 'force-dynamic'

const UsersPage = async () => {
  await requireAdminPage()

  return (
    <>
      <PageHeader
        eyebrow="Access"
        title="Users"
        summary="Every known user, with their role, active state, last sign-in and the runs they own. Deactivation is never deletion: history stays attributed, and runs still in flight are flagged for a new owner."
      />
      <UsersPanel />
    </>
  )
}

export default UsersPage
