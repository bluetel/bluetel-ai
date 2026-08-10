import { ProfileCredentialGroupsPanel } from '@sisyphus-admin/components/admin/credential-groups'
import { PageHeader } from '@sisyphus-admin/components/shell'
import { requireAdminPage } from '@sisyphus-admin/server'

/**
 * `/admin/profiles/{id}` — which credential groups this execution profile draws on, and in what
 * order (T027, FR-062, FR-064, FR-065, FR-067).
 *
 * ## Why the attachments are here and not in the version editor
 *
 * Everything on `/admin/profiles` is versioned: an edit publishes version n+1 and a run keeps the
 * version it recorded at launch. Attachments are deliberately **not** — they hang off the mutable
 * `execution_profiles` row, because the pool a profile draws on is operational capacity rather than
 * part of what a run does, and pinning it to a version would stop a historical run being relaunched
 * once the pool it drew on had been reorganised. Editing them on the version form would say the opposite in the one
 * place an administrator is most likely to believe it, so they are edited here, on the profile
 * itself. See `packages/sisyphus-api/src/server/admin/credential-groups.ts` and data-model.md.
 *
 * ## Two refusals, and they are different refusals
 *
 * 1. **The caller is not an admin.** `requireAdminPage` throws Next.js's `notFound` on the server,
 *    so nothing below runs — no markup, no queries mounted (FR-067).
 * 2. **The profile is not one this caller can read.** That is not decided here. The id in the URL
 *    is the caller's guess, and the *router* answers `NOT_FOUND` for a profile that does not exist
 *    and for one out of scope, identically, so the two cannot be told apart (FR-190). The panel
 *    renders that as "not found". Resolving the profile here to put its name in the heading would
 *    undo the whole thing: a page that can title itself has confirmed the profile exists.
 *
 * That is why the heading names the id rather than the profile, exactly as `[id]/access` does.
 */
export const dynamic = 'force-dynamic'

interface ProfileCredentialGroupsPageProps {
  params: Promise<{ id: string }>
}

const ProfileCredentialGroupsPage = async ({ params }: ProfileCredentialGroupsPageProps) => {
  await requireAdminPage()
  const { id } = await params

  return (
    <>
      <PageHeader
        eyebrow="Execution profile"
        title="Credential groups"
        summary="A run launched from this profile works as an agent credential drawn from one of the groups attached below, in the order they are listed: the first group with an available credential is used. A profile with no usable group cannot be enabled — that is refused here, while it is being configured, rather than at launch with a run already accepted."
      />
      <ProfileCredentialGroupsPanel executionProfileId={id} />
    </>
  )
}

export default ProfileCredentialGroupsPage
