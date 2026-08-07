'use client'

import { describeTrpcError } from '@sisyphus-admin/components/admin/trpc-error'
import type { WorkflowFilters } from '@sisyphus-admin/components/workflows'
import {
  EMPTY_FILTERS,
  invalidIdFilters,
  toListInput,
  toSearchParams,
  toWorkflowRowReadouts,
  WorkflowFilterBar,
  // The page's one clock. A second clock in this directory would put two durations on one screen
  // that could disagree.
  useNow,
  WorkflowList,
} from '@sisyphus-admin/components/workflows'
import { api } from '@sisyphus-admin/trpc'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import type { FleetSpendGrouping } from './spend-grouping'
import { GROUPING_PARAM, toSpendSummaryInput } from './spend-grouping'
import { toSpendReadouts } from './spend-readouts'
import { SpendSummaryCard } from './spend-summary-card'

/**
 * Fleet oversight: every run, filtered across all dimensions, with attributable spend (T135).
 *
 * ## It composes the fleet list rather than reimplementing it
 *
 * The filter bar, the list, the row shaping and the filter serialisation are all
 * `components/workflows`', imported through that barrel. A second filter bar here would be a second
 * place FR-013's filter set is defined and a second query string to keep in step — and a filter
 * that serialised under one name and parsed under another is a bug no markup assertion catches.
 * What this screen adds over `/workflows` is the spend card and the grouping, which is the whole of
 * what makes it the *oversight* view.
 *
 * ## Two queries, one scope, and no arithmetic between them
 *
 * `workflow.list` and `workflow.spendSummary` are both `scopedProcedure` and both compose the
 * FR-190 base selector, so neither can disclose a run the caller may not see — including through a
 * count or a total (SC-051). This component deliberately performs no arithmetic across the two:
 * it does not sum the loaded rows, and it does not compare that sum against the summary. Those
 * numbers answer different questions — the rows are one page, the summary is the whole scope — and
 * presenting either as a check on the other would invent a discrepancy out of pagination.
 *
 * The list's filters likewise do **not** narrow the spend card. `spendSummary` takes a grouping and
 * a date window, not the list's filter set, so a card that appeared to follow the filters would be
 * showing an unfiltered figure under a filtered heading. The card says what it is a total of.
 *
 * ## Nothing here decides visibility
 *
 * There is no client-side hiding to get wrong. A hand-edited query string can only ever match
 * fewer rows, and a grouping the URL invented falls back to the default rather than reaching the
 * procedure — see `./spend-grouping.ts`.
 */

interface FleetPanelProps {
  /** Parsed from the page's search params, so the first render is already the filtered list. */
  readonly initialFilters: WorkflowFilters
  /** Parsed from the same place, and closed over the collective groupings only (FR-156). */
  readonly initialGrouping: FleetSpendGrouping
}

export const FleetPanel = ({ initialFilters, initialGrouping }: FleetPanelProps) => {
  const router = useRouter()
  const [applied, setApplied] = useState<WorkflowFilters>(initialFilters)
  const [draft, setDraft] = useState<WorkflowFilters>(initialFilters)
  const [grouping, setGrouping] = useState<FleetSpendGrouping>(initialGrouping)

  const workflows = api.workflow.list.useInfiniteQuery(toListInput(applied), {
    getNextPageParam: (page) => page.nextCursor,
  })
  const spend = api.workflow.spendSummary.useQuery(toSpendSummaryInput(grouping))

  /** Keep the address bar in step, so the view an operator copies is the view they are looking at. */
  const push = (filters: WorkflowFilters, next: FleetSpendGrouping): void => {
    const params = new URLSearchParams(toSearchParams(filters))
    params.set(GROUPING_PARAM, next)
    router.replace(`/admin/fleet?${params.toString()}`, { scroll: false })
  }

  const apply = (next: WorkflowFilters): void => {
    if (invalidIdFilters(next).length > 0) return

    setDraft(next)
    setApplied(next)
    push(next, grouping)
  }

  const regroup = (next: FleetSpendGrouping): void => {
    setGrouping(next)
    push(applied, next)
  }

  // One clock for the page, so every live duration agrees with every other.
  const now = useNow()
  const rows = (workflows.data?.pages ?? [])
    .flatMap((page) => page.items)
    .map((item) => toWorkflowRowReadouts(item, now))

  return (
    <div className="gap-section flex flex-col">
      <SpendSummaryCard
        readouts={toSpendReadouts(
          spend.data ?? { groups: [], workflowCount: 0, spendTotal: '0.0000', turnsTotal: 0 },
        )}
        grouping={grouping}
        onGroupingChange={regroup}
        loading={spend.isPending}
        error={spend.error === null ? undefined : describeTrpcError(spend.error)}
      />

      <WorkflowFilterBar
        filters={draft}
        pending={workflows.isPending}
        onChange={setDraft}
        onApply={() => {
          apply(draft)
        }}
        onClear={() => {
          apply(EMPTY_FILTERS)
        }}
      />

      <WorkflowList
        rows={rows}
        loading={workflows.isPending}
        loadingMore={workflows.isFetchingNextPage}
        hasMore={workflows.hasNextPage}
        error={workflows.error === null ? undefined : describeTrpcError(workflows.error)}
        onLoadMore={() => {
          void workflows.fetchNextPage()
        }}
      />
    </div>
  )
}
