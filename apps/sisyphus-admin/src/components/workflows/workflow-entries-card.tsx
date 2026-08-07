import { DataReadout } from '@sisyphus-admin/components/admin'
import { Card, CardBody, CardHeader, StateChip } from '@sisyphus-admin/components/ui'

import type { WorkflowEntryReadouts } from './workflow-detail-readouts'

/**
 * What the run did to each repository (FR-114, FR-115, FR-118).
 *
 * The list identifies the **workspace**; this card is where its entries are enumerated, which is
 * the split FR-012 asks for — a row that named every repository would stop being scannable, and a
 * detail view that named only the workspace would hide the fact that one entry failed while
 * another landed.
 *
 * A staleness note is shown as recorded and nothing follows from it. Whether to rebase is for the
 * repository's own skills to decide, not for Sisyphus and not for this panel (FR-079), so there is
 * deliberately no control here.
 */
interface WorkflowEntriesCardProps {
  readonly entries: readonly WorkflowEntryReadouts[]
  readonly loading?: boolean
}

export const WorkflowEntriesCard = ({ entries, loading = false }: WorkflowEntriesCardProps) => (
  <Card aria-label="Repositories">
    <CardHeader>
      <span>repositories</span>
      <StateChip>{loading ? 'reading' : `entries ${String(entries.length)}`}</StateChip>
    </CardHeader>
    <CardBody className="gap-default flex flex-col">
      {loading || entries.length > 0 ? null : (
        <p className="type-data-mono text-graphite">no workspace entries recorded</p>
      )}

      {entries.map((entry) => (
        <div key={entry.id} className="gap-close flex flex-col">
          <div className="gap-default flex flex-wrap">
            <DataReadout label="repository" value={entry.repositoryUrl} />
            <DataReadout label="base branch" value={entry.baseBranch} />
            <DataReadout label="subdirectory" value={entry.subdirectory} />
            <DataReadout label="role" value={entry.role} />
            <DataReadout label="commit" value={entry.resolvedCommit} />
            <DataReadout label="working tree" value={entry.changed} />
            <DataReadout label="result" value={entry.result} />
          </div>

          {entry.pullRequestUrl === null ? null : (
            <a
              href={entry.pullRequestUrl}
              className="focus-ring type-data-mono text-signal"
              rel="noreferrer"
              target="_blank"
            >
              {entry.pullRequestUrl}
            </a>
          )}

          {entry.stalenessNote === null ? null : (
            <div className="gap-hair flex flex-col">
              <span className="type-label-mono text-graphite">base branch</span>
              <p className="type-body text-graphite measure-prose">{entry.stalenessNote}</p>
            </div>
          )}
        </div>
      ))}
    </CardBody>
  </Card>
)
