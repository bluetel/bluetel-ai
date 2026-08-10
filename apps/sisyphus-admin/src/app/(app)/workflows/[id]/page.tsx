import { PageHeader } from '@sisyphus-admin/components/shell'
import { WorkflowDetailPanel } from '@sisyphus-admin/components/workflows'

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
 * ## Where "this run is waiting for an agent credential" is said (003/SC-006, T070)
 *
 * Inside the panel, and it could not be anywhere else on this page. 003/SC-006 asks that an
 * engineer be able to tell from the workflow view alone that a run is waiting for a credential and
 * how long it has waited; the wait, its duration and the 003/FR-029 reason are rendered at the top
 * of the run card by `WorkflowSummaryCard`, derived from the run's own timeline in
 * `components/workflows/credential-wait.ts`.
 *
 * Putting any of it in the shell above would undo the paragraph above this one: a header that could
 * say a run is waiting is a header that has confirmed the run exists, which is the disclosure
 * FR-190 forbids. So the shell stays a function of the URL, and everything that depends on the run
 * being visible stays below the same `NOT_FOUND` the router returned.
 *
 * ## And where "this run parks in eleven minutes" is said (003/FR-047, T105)
 *
 * In the same card, from the same timeline, through
 * `components/workflows/parking-countdown.ts` — deliberately the same structure rather than a
 * second one, because it is the same shape of problem: a fact about the run that the state chip
 * cannot carry, recorded on the timeline rather than in a column, and measured against the page's
 * one clock.
 *
 * FR-047 exists because of what parking costs. Past the idle limit the platform releases the run's
 * instance **and its disk** (FR-044) and the run stands on the snapshot it took when the pause was
 * acknowledged; it keeps its agent credential throughout (FR-073), so it comes back as the same
 * agent either way. No work is lost, but the working tree is, and the only remedy — resume it — is
 * available beforehand. A countdown an owner cannot see is a deadline they can only miss.
 *
 * Both readouts are reported here **and nowhere else**: 003/FR-079 keeps waiting, cooling off and parking off
 * the notification path entirely, and `packages/sisyphus-notify` maps `awaiting_credential` to no
 * event. That mapping is what makes the rule true rather than intended, and it must stay that way —
 * a run that waits and then starts has produced no outcome, and paging its owner about ordinary
 * pool contention they cannot act on would happen once per waiting run every time the pool filled.
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
    <>
      <PageHeader
        eyebrow="Run"
        title={id}
        summary="What this run was configured to do, what it has done so far, and everything it produced. A run you are not permitted to see reads as not found — the same answer a run that never existed gives."
      />
      <WorkflowDetailPanel workflowId={id} />
    </>
  )
}

export default WorkflowDetailPage
