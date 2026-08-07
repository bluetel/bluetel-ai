import {
  FleetPanel,
  GROUPING_PARAM,
  parseSpendGrouping,
} from '@sisyphus-admin/components/admin/fleet'
import { PageHeader } from '@sisyphus-admin/components/shell'
import { parseWorkflowFilters } from '@sisyphus-admin/components/workflows'
import { requireAdminPage } from '@sisyphus-admin/server'

/**
 * `/admin/fleet` — oversight across every run, with attributable spend (T135, US6).
 *
 * ## What this page is, next to `/workflows`
 *
 * `/workflows` is the engineer's list: the runs they are permitted to see, filtered. This is the
 * oversight view of the same data — the same scoped list, plus the spend aggregate grouped by
 * client, workspace or execution profile (FR-041, FR-156). It is under `/admin` and gated like
 * every other page there, so the audience is admins; the gate is a namespace convention, **not**
 * the access control. FR-190 lives in `workflow.list` and `workflow.spendSummary`, which compose
 * the scoped base selector into the statement itself. A page-level gate that were load-bearing
 * would be a second place the rule had to be got right.
 *
 * `requireAdminPage` resolves the session on the server and throws Next.js's `notFound` for anyone
 * who is not an active admin, so the JSX below is never evaluated for them: no markup, no queries
 * mounted, nothing to read in the response. And `notFound` rather than a refusal, for the same
 * reason an out-of-scope read is `NOT_FOUND` — a page that said "you do not have permission" would
 * confirm what is behind it.
 *
 * ## Why the query string is parsed here
 *
 * The server component is the first thing that sees it, so parsing here means the first render is
 * already the filtered, grouped view — no unfiltered flash, and no `useSearchParams` in a client
 * component reading the URL a beat after the page rendered without it.
 *
 * Both parses are total and lossy in one direction only. An unknown state or type is dropped rather
 * than forwarded, so a stale link produces a list rather than a validation error; and a grouping the
 * URL invented — `?by=user` included — falls back to the default rather than reaching the procedure,
 * which is what keeps a hand-edited URL from turning oversight into a per-person league table
 * (FR-156).
 *
 * ## The page resolves nothing about the runs
 *
 * No count, no total, nothing in the heading that depends on what the caller can see. Everything
 * about visibility is decided by the two scoped procedures.
 *
 * Dynamic, because the page is a function of the caller's session and of the query string.
 */
export const dynamic = 'force-dynamic'

interface FleetPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>
}

const FleetPage = async ({ searchParams }: FleetPageProps) => {
  await requireAdminPage()

  const params = await searchParams

  return (
    <>
      <PageHeader
        eyebrow="Fleet"
        title="Oversight"
        summary="Every run you are permitted to see, filtered across every dimension, with spend attributable to the client, workspace or execution profile that incurred it. Totals cover exactly the runs in your scope — a run outside it is absent from the list, the counts and the figures alike."
      />
      <FleetPanel
        initialFilters={parseWorkflowFilters(params)}
        initialGrouping={parseSpendGrouping(params[GROUPING_PARAM])}
      />
    </>
  )
}

export default FleetPage
