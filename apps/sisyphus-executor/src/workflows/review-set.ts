/**
 * Reviewing a pull request **set** (T131, FR-119).
 *
 * ## Why this is not N reviews
 *
 * A multi-entry workflow produces one pull request per repository, all on one branch name, all
 * carrying one change. Reviewing them one at a time is the obvious implementation and it is wrong
 * in a way that is specific rather than aesthetic: the interesting defects in a cross-repository
 * change live **between** the repositories, and a reviewer that only ever sees one of them at a
 * time cannot see any of them.
 *
 * Concretely, three things a per-pull-request review structurally cannot catch:
 *
 * - **The half-applied contract.** The API repository adds a required field and the client
 *   repository does not send it. Each diff is internally consistent; the pair is broken.
 * - **The order that has to hold.** One of the two must merge first or production breaks between
 *   the deploys. That is a fact about the set, and `sisyphus-integration` is where the order is
 *   stated (FR-117).
 * - **The absent change.** The most valuable finding in a cross-repository review is usually about
 *   a repository whose diff is empty — the migration that was not written. A review scoped to one
 *   pull request has no way to express "and the other one should have changed too".
 *
 * So the whole set goes to the reviewer in one request, and **one** verdict comes back (FR-119).
 * Each finding is anchored to entry, file and line, so a single verdict does not cost the reader
 * the ability to tell which repository a blocker is in.
 *
 * ## One verdict means the set fails together
 *
 * A blocker in any entry fails the set, including the entries that are clean. That is the correct
 * answer rather than a harsh one: the clean repository's pull request is part of a change that does
 * not work, and merging it on its own is how the half-applied contract reaches production. FR-118's
 * partial-result recording is about what a run *achieved*; this is about what a reviewer *decided*,
 * and a decision per repository would let the set be merged piecemeal on the strength of it.
 */

import type { SkillReferenceReporter, SkillSource } from '../skills'

import type { IterationFinding } from './iteration-record'
import type { ReviewAssessment, ReviewerPort, ReviewTarget } from './review-step'
import { runReviewStep } from './review-step'

export interface ReviewSetInput {
  readonly ordinal?: number
  readonly source: SkillSource
  readonly report: SkillReferenceReporter
  readonly reviewer: ReviewerPort
  /** Every pull request the run opened, in workspace order. */
  readonly targets: readonly ReviewTarget[]
}

/** The set's verdict, with the findings grouped by the repository they are about. */
export interface ReviewSetAssessment extends ReviewAssessment {
  /** How many pull requests were weighed together. One verdict covers all of them. */
  readonly targetCount: number
  /** Findings by entry id. An entry with none is present with an empty list, not absent. */
  readonly findingsByEntry: ReadonlyMap<string, readonly IterationFinding[]>
  /** Findings the reviewer did not anchor to any entry — about the set as a whole. */
  readonly setWideFindings: readonly IterationFinding[]
}

/** The halt for a finding anchored at a repository this run does not have. */
export const unknownEntryFindingError = (entryId: string, known: readonly string[]): Error =>
  new Error(
    `The review anchored a finding to entry "${entryId}", which is not part of this workspace ` +
      `(it has ${known.join(', ')}). The workflow stops here rather than recording a finding ` +
      'against a repository this run never touched.',
  )

/**
 * Review every pull request of the run together, as one change.
 *
 * @param input - Where the skills are, the agent boundary, and the whole set.
 * @returns One verdict, with its findings grouped by repository.
 * @throws When `sisyphus-review` cannot be used, or a finding names an entry outside the workspace.
 */
export const reviewPullRequestSet = async (input: ReviewSetInput): Promise<ReviewSetAssessment> => {
  // One call, with every target. Not a loop: the reviewer has to be able to see the change as a
  // whole, and a reviewer called once per pull request cannot.
  const assessment = await runReviewStep({
    ...(input.ordinal === undefined ? {} : { ordinal: input.ordinal }),
    source: input.source,
    report: input.report,
    reviewer: input.reviewer,
    targets: input.targets,
  })

  const known = input.targets.map((target) => target.entryId)
  const grouped = new Map<string, IterationFinding[]>(known.map((entryId) => [entryId, []]))
  const setWide: IterationFinding[] = []

  for (const finding of assessment.findings) {
    if (finding.workflowEntryId === undefined) {
      setWide.push(finding)
      continue
    }

    const bucket = grouped.get(finding.workflowEntryId)

    if (bucket === undefined) {
      throw unknownEntryFindingError(finding.workflowEntryId, known)
    }

    bucket.push(finding)
  }

  return {
    ...assessment,
    targetCount: input.targets.length,
    findingsByEntry: grouped,
    setWideFindings: setWide,
  }
}
