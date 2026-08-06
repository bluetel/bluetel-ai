'use client'

import { describeTrpcError } from '@sisyphus-admin/components/admin'
import { api } from '@sisyphus-admin/trpc'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { useNow } from './use-now'
import { WorkflowFilterBar } from './workflow-filter-bar'
import type { WorkflowFilters } from './workflow-filters'
import { EMPTY_FILTERS, invalidIdFilters, toListInput, toSearchParams } from './workflow-filters'
import { WorkflowList } from './workflow-list'
import { toWorkflowRowReadouts } from './workflow-listing'

/**
 * The fleet list screen (T076, FR-012, FR-013, FR-190).
 *
 * This module is wiring: one query, two pieces of state, and the push that keeps the address bar
 * in step with what is on screen. Everything that can be *wrong* — how a row reads, how a filter
 * serialises, what "there is more" means — lives in the modules beside it with its own test.
 *
 * ## How the list pages
 *
 * `useInfiniteQuery`, with `getNextPageParam` reading the `nextCursor` the procedure returned and
 * nothing else. That cursor is the id of the last row the caller was shown, and `workflow.list`
 * turns it into a keyset predicate on a UUID v7 primary key. There is deliberately no page number,
 * no offset and no total: the procedure over-fetches by one row to answer "is there more" and
 * issues no companion `count(*)`, and a UI that asked for either would put back exactly the
 * index-wide read that design removed (FR-012, FR-013).
 *
 * ## How the filters are carried
 *
 * In the query string. The server component parses them and hands them in as `initialFilters`, so
 * the first render is already the filtered list rather than an unfiltered one that flickers; every
 * apply pushes the serialised filters back with `router.replace`, so the URL an operator copies is
 * the list they are looking at. The draft the bar edits is separate from the applied set the query
 * uses — see `./workflow-filter-bar` for why a filtered list must not re-query per keystroke.
 *
 * ## FR-190
 *
 * Nothing in this component decides what is visible. `workflow.list` composes every filter inside
 * the scoped base selector, so a hand-edited query string can only ever match fewer rows. There is
 * no client-side hiding here to get wrong, which is the point.
 */

interface WorkflowsPanelProps {
  /** Parsed from the page's search params, so the first render is the filtered list. */
  readonly initialFilters: WorkflowFilters
}

export const WorkflowsPanel = ({ initialFilters }: WorkflowsPanelProps) => {
  const router = useRouter()
  const [applied, setApplied] = useState<WorkflowFilters>(initialFilters)
  const [draft, setDraft] = useState<WorkflowFilters>(initialFilters)

  const workflows = api.workflow.list.useInfiniteQuery(toListInput(applied), {
    getNextPageParam: (page) => page.nextCursor,
  })

  const apply = (next: WorkflowFilters): void => {
    if (invalidIdFilters(next).length > 0) return

    setDraft(next)
    setApplied(next)

    const query = toSearchParams(next)
    router.replace(query === '' ? '/workflows' : `/workflows?${query}`, { scroll: false })
  }

  // One clock for the page, so every live duration agrees with every other. It is `undefined`
  // until the browser has ticked — see `./use-now.ts` for why that is deliberate.
  const now = useNow()
  const rows = (workflows.data?.pages ?? [])
    .flatMap((page) => page.items)
    .map((item) => toWorkflowRowReadouts(item, now))

  return (
    <div className="gap-section flex flex-col">
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
