import { PageHeader } from '@sisyphus-admin/components/shell'

import { WorkflowChainSlot } from './chain-view-slot'

/**
 * `/workflows/{id}/chain` — the successor chain, traversable both ways (T102, FR-152, FR-190).
 *
 * ## The heading names the id, not the run
 *
 * The same rule as `/workflows/{id}`, and for the same reason: the id in the URL is the caller's
 * guess, and every read behind this page answers `NOT_FOUND` for a run that does not exist and for
 * one outside the caller's scope, identically. A page that titled itself from the run's ticket
 * reference would have confirmed the run exists before the view had decided whether to say so.
 *
 * The chain itself is assembled by `workflow.chain`, which walks the run's predecessors **and** its
 * successors — the second of which no workflow read can provide. The loader that reaches it is built
 * in `./chain-view-slot.tsx`, because a loader is a function and a server component cannot hand one
 * to a client component.
 *
 * Dynamic, because the page is a function of the caller's session.
 */
export const dynamic = 'force-dynamic'

interface WorkflowChainPageProps {
  readonly params: Promise<{ id: string }>
}

const WorkflowChainPage = async ({ params }: WorkflowChainPageProps) => {
  const { id } = await params

  return (
    <>
      <PageHeader
        eyebrow="Chain"
        title={id}
        summary="Every run in this chain, oldest first — what each one continued, what continued it, and what the whole sequence has cost. A run you are not permitted to see is neither listed nor counted."
      />
      <WorkflowChainSlot workflowId={id} />
    </>
  )
}

export default WorkflowChainPage
