import { DataReadout } from '@sisyphus-admin/components/admin'
import { Card, CardBody, CardHeader, StateChip } from '@sisyphus-admin/components/ui'

import type { EntryResultsReadouts } from './entry-result-readouts'

/**
 * Where a multi-repository run actually got to (T108, FR-116, FR-118).
 *
 * ## What this card is for, given `WorkflowEntriesCard` exists
 *
 * That card enumerates the workspace: what each repository is, where it was checked out, what
 * commit it was pinned at. This one is about the **set**, and it exists because FR-118's failure
 * mode is a reading failure rather than a recording one. Three cards saying `landed`, `landed`,
 * `failed` contain the whole truth and still let a reader come away believing the run worked; the
 * arithmetic is done for them here, and the answer is a sentence rather than a ratio, because a
 * ratio is something the eye slides past.
 *
 * ## The partial result is announced, not merely displayed
 *
 * It is a `role="status"` region, so a screen reader hears it when it appears rather than only if
 * the reader happens to navigate into this card. `role="alert"` would be wrong: the run has already
 * finished, and interrupting somebody for a fact about the past is not urgency, it is noise.
 *
 * ## The shared branch is the reviewer's handle (FR-116)
 *
 * Where a run produced more than one pull request they share one branch name, and that name is what
 * lets a reviewer find the rest of the set from any one of them. It is shown exactly when there is
 * more than one — on a single-repository run it is one more field saying what the pull request link
 * already says.
 *
 * ## No colour, and no control
 *
 * The chip is the idle graphite one. Colour on this panel means machine state (FR-025, FR-030), and
 * an entry result is not a workflow state — tinting this red would be a state colour used to make a
 * point. There is likewise nothing to press: what to do about a repository that did not land is the
 * repository's own business, and this card reports rather than offers.
 */
interface EntryResultsCardProps {
  readonly results: EntryResultsReadouts
  readonly loading?: boolean
}

export const EntryResultsCard = ({ results, loading = false }: EntryResultsCardProps) => (
  <Card aria-label="Entry results">
    <CardHeader>
      <span>entry results</span>
      <StateChip>{loading ? 'reading' : results.readout}</StateChip>
    </CardHeader>
    <CardBody className="gap-default flex flex-col">
      {loading ? (
        <p className="type-data-mono text-graphite">reading this run</p>
      ) : (
        <div role="status" className="gap-hair flex flex-col">
          <p className="type-body text-ink measure-prose">{results.statement}</p>
          {results.isPartial ? (
            <p className="type-body text-graphite measure-prose">
              Some repositories carry this change and some do not. Anything already merged is live
              on its own; the rest is not.
            </p>
          ) : null}
        </div>
      )}

      {loading || results.entries.length === 0 ? null : (
        <div className="gap-default flex flex-wrap">
          <DataReadout label="landed" value={String(results.counts.landed)} />
          <DataReadout label="unchanged" value={String(results.counts.unchanged)} />
          <DataReadout label="failed" value={String(results.counts.failed)} />
          <DataReadout label="not reported" value={String(results.counts.pending)} />
        </div>
      )}

      {results.pullRequestCount > 1 && results.sharedBranch !== null ? (
        <DataReadout label="shared branch" value={results.sharedBranch} />
      ) : null}

      {results.entries.map((entry) => (
        <div key={entry.id} className="gap-close flex flex-col">
          <div className="gap-default flex flex-wrap">
            <DataReadout label="repository" value={entry.repositoryUrl} />
            <DataReadout label="role" value={entry.role} />
            <DataReadout label="standing" value={entry.standing} />
            <DataReadout label="commit" value={entry.commit} />
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
        </div>
      ))}

      {loading || results.entries.length > 0 ? null : (
        <p className="type-data-mono text-graphite">no workspace entries recorded</p>
      )}
    </CardBody>
  </Card>
)
