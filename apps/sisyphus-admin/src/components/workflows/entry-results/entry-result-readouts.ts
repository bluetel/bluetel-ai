import type { WorkflowDetailResult } from '../workflow-detail-readouts'
import { ABSENT } from '../workflow-listing'

/**
 * Shaping the per-entry results of a multi-repository run into one answer (T108, FR-114, FR-116,
 * FR-118).
 *
 * ## Why this exists beside `workflow-detail-readouts.ts`
 *
 * `toWorkflowEntryReadouts` already shapes the entries, and `WorkflowEntriesCard` already
 * enumerates them: repository, base branch, subdirectory, commit, result. That card answers *what
 * is in this workspace and what happened to each part of it*, one row at a time.
 *
 * The question it cannot answer is the one FR-118 is about, because it is a question about the set
 * rather than about any row: **did this run finish?** A reader scanning three cards, two of which
 * say `landed` and one of which says `failed`, has to do that arithmetic themselves, and the whole
 * failure mode FR-118 names is a partial result being read as a success. So the aggregate is
 * computed here, once, and stated in a sentence.
 *
 * ## An unreported entry is not a blank
 *
 * An entry with no `entryResult` reads as `pending`, and it counts against the run exactly as a
 * failure does. It is the more misleading of the two: the run stopped before it reached that
 * repository, so nothing anywhere records a failure, and a card that showed an empty cell would let
 * "we never got there" look like "nothing to report".
 *
 * ## `unchanged` is finished, not half-done
 *
 * A repository the work did not need to touch has not fallen short. Counting it as a shortfall
 * would make every one-sided change in a multi-repository workspace read as partial, which would
 * make the partial-result notice meaningless within a week of anyone seeing it.
 *
 * ## Nothing here decides anything
 *
 * The workflow's terminal outcome is the platform's to record, not the panel's to infer
 * (`packages/sisyphus-api/src/server/machine/entries.ts` holds that rule). This shapes what is
 * already true into something readable; if the outcome and this notice ever disagree, the outcome
 * is the record and the disagreement is the bug.
 */

/** What happened to one repository. `pending` is the platform's silence, named. */
export type EntryStanding = 'landed' | 'unchanged' | 'failed' | 'pending'

/** One repository, as the results card reads it. */
export interface EntryOutcomeReadouts {
  readonly id: string
  readonly repositoryUrl: string
  readonly standing: EntryStanding
  readonly role: string
  /** FR-114 — recorded at checkout, so it is present even for a run that never delivered. */
  readonly commit: string
  readonly pullRequestUrl: string | null
}

/** How many repositories are in each standing. */
export interface EntryStandingCounts {
  readonly landed: number
  readonly unchanged: number
  readonly failed: number
  readonly pending: number
}

/** The whole set, as one answer. */
export interface EntryResultsReadouts {
  readonly entries: readonly EntryOutcomeReadouts[]
  readonly counts: EntryStandingCounts
  /** The chip's readout — `landed 2 / 3`. */
  readonly readout: string
  /** Something landed and something did not (FR-118). */
  readonly isPartial: boolean
  /** One sentence saying where the run got to. Always present, even when it is good news. */
  readonly statement: string
  /**
   * The branch every pull request in the set shares (FR-116), or `null` when the run has not
   * recorded one. Shown only where there is more than one pull request to join up.
   */
  readonly sharedBranch: string | null
  readonly pullRequestCount: number
}

const standingOf = (entry: WorkflowDetailResult['entries'][number]): EntryStanding =>
  entry.entryResult ?? 'pending'

const repositories = (count: number): string =>
  `${String(count)} ${count === 1 ? 'repository' : 'repositories'}`

/**
 * Say where the run got to, in one sentence.
 *
 * Written as prose rather than as a count with a colour, because the thing being communicated is a
 * judgement a reader has to act on — and "2 / 3" is a number somebody can read past.
 */
const statementFor = (counts: EntryStandingCounts, total: number): string => {
  const shortfall = counts.failed + counts.pending

  if (total === 0) {
    return 'This run has no workspace entries recorded.'
  }

  if (shortfall === 0) {
    return counts.landed === 0
      ? `Nothing needed changing in ${repositories(total)}.`
      : `All of ${repositories(total)} are accounted for: ${String(counts.landed)} landed, ${String(counts.unchanged)} unchanged.`
  }

  const shortfallParts = [
    counts.failed === 0 ? undefined : `${String(counts.failed)} failed`,
    counts.pending === 0 ? undefined : `${String(counts.pending)} never reported`,
  ].filter((part): part is string => part !== undefined)

  return counts.landed === 0
    ? `No repository landed: ${shortfallParts.join(' and ')}. This run did not do the work it was given.`
    : `${String(counts.landed)} of ${repositories(total)} landed and ${shortfallParts.join(' and ')}. This is a partial result, not a success.`
}

/**
 * Derive the results readouts for one run.
 *
 * @param detail - The run as `workflow.byId` returned it.
 */
export const toEntryResultsReadouts = (detail: WorkflowDetailResult): EntryResultsReadouts => {
  const entries = detail.entries.map(
    (entry): EntryOutcomeReadouts => ({
      id: entry.id,
      repositoryUrl: entry.repositoryUrl,
      standing: standingOf(entry),
      role: entry.isPrimary ? 'primary' : 'secondary',
      commit: entry.resolvedCommit ?? ABSENT,
      pullRequestUrl: entry.pullRequestUrl,
    }),
  )

  const count = (standing: EntryStanding): number =>
    entries.filter((entry) => entry.standing === standing).length

  const counts: EntryStandingCounts = {
    landed: count('landed'),
    unchanged: count('unchanged'),
    failed: count('failed'),
    pending: count('pending'),
  }

  const pullRequestCount = entries.filter((entry) => entry.pullRequestUrl !== null).length

  return {
    entries,
    counts,
    readout: `landed ${String(counts.landed)} / ${String(entries.length)}`,
    isPartial: counts.landed > 0 && counts.failed + counts.pending > 0,
    statement: statementFor(counts, entries.length),
    sharedBranch: detail.workflow.resultBranchName,
    pullRequestCount,
  }
}
