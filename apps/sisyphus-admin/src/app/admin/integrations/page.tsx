import { AdminShell } from '@sisyphus-admin/components/admin'
import {
  createUnavailableIntegrationsClient,
  IntegrationsPanel,
} from '@sisyphus-admin/components/admin/integrations'
import { env } from '@sisyphus-admin/env'
import { requireAdminPage } from '@sisyphus-admin/server'

/**
 * `/admin/integrations` — the boards the platform polls (T121, FR-096..FR-098, FR-186).
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
 * ## The client is injected, and today it refuses
 *
 * `admin.integrations` is implemented in `packages/sisyphus-api/src/server/admin/integrations.ts`
 * and is **not yet mounted** on `adminRouter`. Until it is, `api.admin.integrations` does not exist
 * on `AppRouter`, so this page supplies {@link createUnavailableIntegrationsClient}: the screen
 * renders, and says it cannot read rather than showing an empty list. An admin looking at zero
 * integrations would conclude none are configured, which is a different and worse statement than
 * "this deployment cannot answer".
 *
 * **To finish the wiring**: mount `integrationsRouter` as `integrations` on `adminRouter`, then
 * replace the client below with an adapter over `api.admin.integrations` — the port in
 * `integrations-client.ts` is one method per procedure, in the order the panel calls them.
 *
 * Dynamic, because the page is a function of the caller's session.
 */
export const dynamic = 'force-dynamic'

const IntegrationsAdminPage = async () => {
  await requireAdminPage()

  return (
    <AdminShell
      siteUrl={env.NEXT_PUBLIC_SITE_URL}
      eyebrow="Configuration"
      title="Integrations"
      summary="A board is polled on a schedule, in its own timezone, and each matched ticket starts exactly one workflow on the execution profile its mappings resolve to. The credential is write-only: it is entered here, stored in the secret store, and never returned."
    >
      <IntegrationsPanel client={createUnavailableIntegrationsClient()} profiles={[]} owners={[]} />
    </AdminShell>
  )
}

export default IntegrationsAdminPage
