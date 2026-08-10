import { CredentialGroupsPanel } from '@sisyphus-admin/components/admin/credential-groups'
import { PageHeader } from '@sisyphus-admin/components/shell'
import { requireAdminPage } from '@sisyphus-admin/server'

/**
 * `/admin/credentials/groups` — the capacity pools agent credentials belong to (T026,
 * FR-060..FR-067).
 *
 * ## The gate is the requirement, not a precaution
 *
 * FR-067 makes creating, renaming, disabling and deleting a group, and changing its membership,
 * admin-only. A non-admin able to edit these could attach capacity to a profile they hold, or
 * withdraw it from one they do not, and the credential scoping in FR-063 would stop meaning
 * anything. `requireAdminPage` throws Next.js's `notFound` on the **server**, so nothing below
 * runs: no markup, no queries mounted. `not-found` rather than `forbidden`, decided once in
 * `@sisyphus-admin/server`, because a permission page confirms that what is behind it exists
 * (FR-190). The router behind the panel is gated a second time, with `adminProcedure`.
 *
 * ## Why the summary leads with deletion
 *
 * The one thing an administrator will try on this screen and be refused is deleting a group, and
 * FR-066 makes that refusal the normal case rather than the exception. Saying up front that
 * disabling is what the platform offers instead means the refusal reads as the rule when it
 * arrives, rather than as something that went wrong.
 *
 * Dynamic, because the page is a function of the caller's session.
 */
export const dynamic = 'force-dynamic'

const CredentialGroupsAdminPage = async () => {
  await requireAdminPage()

  return (
    <>
      <PageHeader
        eyebrow="Credentials"
        title="Credential groups"
        summary="A group is the pool of agent identities an execution profile draws on, and every credential belongs to exactly one. A group that holds a credential, or that a profile is attached to, cannot be deleted — it is disabled instead, which withholds every member from future selection without interrupting a run that is holding one."
      />
      <CredentialGroupsPanel />
    </>
  )
}

export default CredentialGroupsAdminPage
