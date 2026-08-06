import { AdminShell } from '@sisyphus-admin/components/admin'
import { ProfilesPanel } from '@sisyphus-admin/components/admin/profiles'
import { WorkspacesPanel } from '@sisyphus-admin/components/admin/workspaces'
import { env } from '@sisyphus-admin/env'
import { requireAdminPage } from '@sisyphus-admin/server'

/**
 * `/admin/profiles` — workspaces and execution profiles (T082, FR-121..FR-128, FR-185).
 *
 * ## Why both live on one page
 *
 * A profile pins a **workspace version**, so the two are edited together in practice: an admin
 * adding a repository to a workspace has not changed any profile until they publish a profile
 * version that pins the new workspace version. Splitting them across two screens would hide that
 * second step, and the failure it produces — a profile still pointing at last week's repository
 * set — is silent.
 *
 * ## The gate is the requirement, not a precaution
 *
 * FR-185 makes creating and editing either of these admin-only, because a non-admin able to edit
 * one could point a profile they hold at a repository or setup bundle they were never granted,
 * which would defeat the access model entirely. `requireAdminPage` throws Next.js's `notFound` on
 * the **server**, so nothing below runs: no markup, no queries mounted (FR-169). `not-found` rather
 * than `forbidden`, decided once in `@sisyphus-admin/server`, because a permission page confirms
 * that what is behind it exists (FR-190).
 *
 * The gate is not added as a layout, because `[id]/access` beneath this route already opens with
 * its own and a second one would be two places to keep a rule.
 *
 * Dynamic, because the page is a function of the caller's session.
 */
export const dynamic = 'force-dynamic'

const ProfilesAdminPage = async () => {
  await requireAdminPage()

  return (
    <AdminShell
      siteUrl={env.NEXT_PUBLIC_SITE_URL}
      eyebrow="Configuration"
      title="Workspaces and execution profiles"
      summary="Both are versioned. Editing either publishes a new version rather than changing the existing one, and a workflow keeps the version it pinned when it launched — so an edit mid-run never changes what an agent is working on."
    >
      <ProfilesPanel />
      <WorkspacesPanel />
    </AdminShell>
  )
}

export default ProfilesAdminPage
