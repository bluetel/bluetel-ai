import { AdminShell } from '@sisyphus-admin/components/admin'
import { WorkflowDetailPanel } from '@sisyphus-admin/components/workflows'
import { env } from '@sisyphus-admin/env'

/**
 * `/workflows/{id}` — one run in full (T076, FR-014, FR-190).
 *
 * ## The heading names the id, not the run
 *
 * The id in the URL is the caller's guess. `workflow.byId` answers `NOT_FOUND` for a run that does
 * not exist and for one outside the caller's scope, identically, so the two cannot be told apart —
 * and resolving the run here to put its ticket reference in the title would undo the whole thing.
 * A page that can title itself has confirmed the run exists, which is exactly the disclosure
 * FR-190 forbids. So the shell is titled from fixed text plus the URL, and everything that depends
 * on the run being visible is inside the panel, below the same `NOT_FOUND` the router returned.
 *
 * Dynamic, because the page is a function of the caller's session.
 */
export const dynamic = 'force-dynamic'

interface WorkflowDetailPageProps {
  readonly params: Promise<{ id: string }>
}

const WorkflowDetailPage = async ({ params }: WorkflowDetailPageProps) => {
  const { id } = await params

  return (
    <AdminShell
      siteUrl={env.NEXT_PUBLIC_SITE_URL}
      eyebrow="Run"
      title={id}
      summary="What this run was configured to do, what it has done so far, and everything it produced. A run you are not permitted to see reads as not found — the same answer a run that never existed gives."
    >
      <WorkflowDetailPanel workflowId={id} />
    </AdminShell>
  )
}

export default WorkflowDetailPage
