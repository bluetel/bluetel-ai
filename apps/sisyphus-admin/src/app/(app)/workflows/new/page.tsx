import { PageHeader } from '@sisyphus-admin/components/shell'
import { LaunchPanel } from '@sisyphus-admin/components/workflows/new'
import { auth, isAdminSessionUser } from '@sisyphus-admin/lib/auth'

/**
 * `/workflows/new` — the launch form (T064a, T080, FR-016, FR-122, FR-129, FR-187).
 *
 * ## Why the gate is a session gate now, and why that is not a relaxation
 *
 * T064a gated this page on the admin role, because the ad hoc path was the only way to start a run
 * and an ad hoc launch *is* an execution profile — an unnamed one that nobody granted to anybody
 * (FR-187). T080 adds the profile-first path, which is the path FR-122 says everybody has: a
 * non-admin launches on a profile granted to them, and refusing them this page would make the
 * product's primary action invisible to the people it is for.
 *
 * So the page is reachable by any active session — `/workflows/layout.tsx` above it is what
 * enforces that, and it is the same gate the fleet list uses — and the **fields** carry the role.
 * `canLaunchAdHoc` is resolved here, on the server, and the direct-entry form is not rendered
 * without it. That is a narrowing of what is shipped, not a style applied to shipped markup.
 *
 * The gate that actually matters is neither of those. `workflow.startAdHoc` is an
 * `adminProcedure`, so a non-admin who reconstructed the request is refused and the attempt is
 * recorded; `workflow.start` is a `scopedProcedure`, so a profile the caller does not hold comes
 * back as the same `NOT_FOUND` a nonexistent one does (FR-180, FR-190). A page gate protects the
 * page and not the API, which is why the role is checked in three places and only one of them is
 * load-bearing.
 *
 * Dynamic, because the page is a function of the caller's session.
 */
export const dynamic = 'force-dynamic'

const NewWorkflowPage = async () => {
  const user = (await auth())?.user
  const canLaunchAdHoc = user !== undefined && isAdminSessionUser(user)

  return (
    <>
      <PageHeader
        eyebrow="Workflows"
        title="Launch a run"
        summary="Choose an execution profile and it fills in everything but the prompt. Starting a run writes a queued row and returns — the control plane admits it afterwards, so nothing is provisioned by pressing this button."
      />
      <LaunchPanel canLaunchAdHoc={canLaunchAdHoc} />
    </>
  )
}

export default NewWorkflowPage
