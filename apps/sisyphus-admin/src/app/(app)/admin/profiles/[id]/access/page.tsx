import { ProfileAccessPanel } from '@sisyphus-admin/components/admin/grants'
import { PageHeader } from '@sisyphus-admin/components/shell'
import { requireAdminPage } from '@sisyphus-admin/server'

/**
 * `/admin/profiles/{id}/access` — who may launch on this execution profile (T043, FR-179, FR-184).
 *
 * Two refusals, and they are different refusals:
 *
 * 1. **The caller is not an admin.** `requireAdminPage` throws Next.js's `notFound` on the server,
 *    so nothing below runs — no markup, no queries mounted (FR-169).
 * 2. **The profile is not one this caller can read.** That is not decided here. The id in the URL
 *    is the caller's guess, and the *router* answers `NOT_FOUND` for a profile that does not exist
 *    and for one out of scope, identically, so the two cannot be told apart (FR-190). The panel
 *    renders that as "not found". Resolving the profile here to put its name in the heading would
 *    undo the whole thing: a page that can title itself has confirmed the profile exists.
 *
 * That is why the heading names the id rather than the profile.
 */
export const dynamic = 'force-dynamic'

interface ProfileAccessPageProps {
  params: Promise<{ id: string }>
}

const ProfileAccessPage = async ({ params }: ProfileAccessPageProps) => {
  await requireAdminPage()
  const { id } = await params

  return (
    <>
      <PageHeader
        eyebrow="Execution profile"
        title="Access"
        summary="The execution profile is the unit of access control. Granting it grants exactly “you may do this kind of work, on these repositories, with these credentials, at this cost” — and revoking it takes effect at the holder’s next request."
      />
      <ProfileAccessPanel executionProfileId={id} />
    </>
  )
}

export default ProfileAccessPage
