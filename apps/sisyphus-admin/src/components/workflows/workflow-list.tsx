import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  FieldError,
  StateChip,
} from '@sisyphus-admin/components/ui'

import type { WorkflowRowReadouts } from './workflow-listing'
import { WorkflowRow } from './workflow-row'

/**
 * The fleet list, with its paging control (FR-012, FR-013).
 *
 * ## Paging is a cursor, and the control says so
 *
 * `workflow.list` is keyset-paginated on a UUID v7 primary key with a `limit + 1` over-fetch and
 * **no companion `count(*)`** — which is what keeps it on an index at tens of thousands of runs.
 * Two things follow for this component, and both are load-bearing rather than stylistic:
 *
 * 1. **There are no page numbers.** A numbered pager needs a total and an offset, and asking for
 *    either would undo the query's design: the count is a second scoped index-wide read, and the
 *    offset re-reads rows a concurrent insert has shifted, which on a newest-first list is every
 *    row on every page. So the control is "load more", and it is enabled exactly when the server
 *    handed back a cursor.
 * 2. **The readout counts what is loaded, not what exists.** `loaded 75` is true; `75 of 12,431`
 *    is a number nothing computed. Where the caller has not reached the end, the chip says so
 *    with a `+`, which is the honest shape of "there is more".
 *
 * ## Presentational
 *
 * It takes rows, not a query. The query lives in `./workflows-panel`, so this component can be
 * rendered and asserted without a query client — which is what makes the empty state, the loading
 * state and the end-of-list state testable at all.
 */
interface WorkflowListProps {
  readonly rows: readonly WorkflowRowReadouts[]
  /** True while the first page is being read, as distinct from there being nothing to show. */
  readonly loading?: boolean
  /** True while a further page is being read. */
  readonly loadingMore?: boolean
  /** Whether the server handed back a cursor. There is no other definition of "there is more". */
  readonly hasMore?: boolean
  readonly error?: FieldErrorContent
  readonly onLoadMore: () => void
}

export const WorkflowList = ({
  rows,
  loading = false,
  loadingMore = false,
  hasMore = false,
  error,
  onLoadMore,
}: WorkflowListProps) => (
  <div className="gap-default flex flex-col">
    <Card aria-label="Workflows">
      <CardHeader>
        <span>workflows</span>
        <StateChip>
          {loading ? 'reading' : `loaded ${String(rows.length)}${hasMore ? '+' : ''}`}
        </StateChip>
      </CardHeader>
      <CardBody className="gap-close flex flex-col">
        <p className="type-body text-graphite measure-prose">
          Every run you are permitted to see, newest first. The list pages forward from the last row
          you were shown rather than by page number, so a run started while you were reading does
          not shift the page under you.
        </p>
        {error === undefined ? null : <FieldError {...error} />}
        {loading || rows.length > 0 ? null : (
          <p className="type-data-mono text-graphite">no runs match these filters</p>
        )}
      </CardBody>
    </Card>

    {rows.map((row) => (
      <WorkflowRow key={row.id} row={row} />
    ))}

    {hasMore ? (
      <div className="gap-close flex items-center">
        {loadingMore ? (
          <Button variant="secondary" pending readout="Loading" />
        ) : (
          <Button variant="secondary" onClick={onLoadMore}>
            Load more
          </Button>
        )}
        <span className="type-data-mono text-graphite">
          paged by cursor from the last row shown
        </span>
      </div>
    ) : null}
  </div>
)
