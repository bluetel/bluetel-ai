import { PageHeader } from '@sisyphus-admin/components/shell'
import { parseWorkflowFilters, WorkflowsPanel } from '@sisyphus-admin/components/workflows'

/**
 * `/workflows` — the fleet list (T076, FR-012, FR-013, FR-190).
 *
 * ## Why the filters are parsed here rather than in the client
 *
 * The query string is the filter state, and the server component is the first thing that sees it.
 * Parsing here means the panel's very first render is already the filtered list — no unfiltered
 * flash, and no `useSearchParams` in a client component, which would need its own Suspense
 * boundary and would read the URL a beat after the page had already rendered without it.
 *
 * The parse is total and lossy in one direction only: an unknown state or type in a hand-edited
 * URL is dropped rather than forwarded, so a stale link produces a list rather than a validation
 * error. See `components/workflows/workflow-filters.ts`.
 *
 * ## The page resolves nothing about the runs
 *
 * No count, no summary, nothing in the heading that depends on what the caller can see. Everything
 * about visibility is decided by `scopedProcedure` inside `workflow.list` (FR-190), and a page
 * that pre-resolved a total would be a second place the rule had to be got right.
 *
 * Dynamic, because the page is a function of the caller's session and of the query string.
 */
export const dynamic = 'force-dynamic'

interface WorkflowsPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>
}

const WorkflowsPage = async ({ searchParams }: WorkflowsPageProps) => {
  const filters = parseWorkflowFilters(await searchParams)

  return (
    <>
      <PageHeader
        eyebrow="Fleet"
        title="Workflows"
        summary="Every run you are permitted to see, current and past. Filters narrow what is already visible to you — they never widen it, and a run outside your scope does not appear in a list, a count or a total."
      />
      <WorkflowsPanel initialFilters={filters} />
    </>
  )
}

export default WorkflowsPage
