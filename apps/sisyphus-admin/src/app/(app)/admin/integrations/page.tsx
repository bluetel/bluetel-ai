import { IntegrationsScreen } from '@sisyphus-admin/components/admin/integrations'
import { PageHeader } from '@sisyphus-admin/components/shell'
import { requireAdminPage } from '@sisyphus-admin/server'

/**
 * `/admin/integrations` — the boards the platform polls (T121, T199, FR-096..FR-098, FR-186).
 *
 * ## The gate is the requirement, not a precaution
 *
 * FR-186 makes creating, editing, enabling, disabling, deleting and manually triggering an
 * integration admin-only, because an integration spends money unattended on behalf of everyone.
 * `requireAdminPage` throws Next.js's `notFound` on the **server**, so nothing below runs: no
 * markup, no queries mounted. `not-found` rather than `forbidden`, decided once in
 * `@sisyphus-admin/server`, because a permission page confirms that what is behind it exists
 * (FR-190).
 *
 * ## The screen reads for itself
 *
 * `admin.integrations` is mounted on `adminRouter`, and `IntegrationsScreen` is the client boundary
 * that reaches it: it supplies the panel's port from `api-integrations-client.ts` and reads the two
 * pickers the editor needs (execution profiles for FR-130's mappings, active users for FR-133's
 * default owner). This page therefore passes it nothing — a server component holding a tRPC client
 * or a query would be the wrong half of the boundary.
 *
 * Dynamic, because the page is a function of the caller's session.
 */
export const dynamic = 'force-dynamic'

const IntegrationsAdminPage = async () => {
  await requireAdminPage()

  return (
    <>
      <PageHeader
        eyebrow="Configuration"
        title="Integrations"
        summary="A board is polled on a schedule, in its own timezone, and each matched ticket starts exactly one workflow on the execution profile its mappings resolve to. The credential is write-only: it is entered here, stored in the secret store, and never returned."
      />
      <IntegrationsScreen />
    </>
  )
}

export default IntegrationsAdminPage
