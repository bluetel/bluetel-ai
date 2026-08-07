import { DataReadout } from '@sisyphus-admin/components/admin'
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  LoadingState,
  StateChip,
} from '@sisyphus-admin/components/ui'

import type { ArtifactReadouts } from './workflow-detail-readouts'

/**
 * Everything the run produced (FR-014, SC-012).
 *
 * An artifact whose stored object has expired stays listed, with the date it expired, rather than
 * vanishing. That is the whole reason this card renders expiry at all: a gap in the record has to
 * read as retention, not as a run that produced nothing. Dropping the row would make a six-month-old
 * successful run indistinguishable from a failed one.
 *
 * External artifacts — a pull request — are links; stored ones show their object key as a readout,
 * because the panel has no signed-download route yet and a key that looked like a link would be a
 * control that does nothing.
 */
interface WorkflowArtifactsCardProps {
  readonly artifacts: readonly ArtifactReadouts[]
  readonly loading?: boolean
}

export const WorkflowArtifactsCard = ({
  artifacts,
  loading = false,
}: WorkflowArtifactsCardProps) => (
  <Card aria-label="Artifacts">
    <CardHeader>
      <span>artifacts</span>
      <StateChip>{loading ? 'reading' : `recorded ${String(artifacts.length)}`}</StateChip>
    </CardHeader>
    <CardBody className="gap-default flex flex-col">
      {loading ? <LoadingState>reading what this run produced</LoadingState> : null}

      {loading || artifacts.length > 0 ? null : (
        <EmptyState>nothing has been recorded for this run</EmptyState>
      )}

      {artifacts.map((artifact) => (
        <div key={artifact.id} className="gap-close flex flex-wrap items-center">
          <DataReadout label="kind" value={artifact.kind} />
          <DataReadout label="recorded" value={artifact.recordedAt} />
          {artifact.expired === undefined ? null : (
            <DataReadout label="expired" value={artifact.expired} />
          )}
          {artifact.externalUrl === null ? (
            <DataReadout label="object" value={artifact.location} />
          ) : (
            <a
              href={artifact.externalUrl}
              className="focus-ring type-data-mono text-signal"
              rel="noreferrer"
              target="_blank"
            >
              {artifact.externalUrl}
            </a>
          )}
        </div>
      ))}
    </CardBody>
  </Card>
)
