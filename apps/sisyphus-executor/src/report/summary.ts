/**
 * The reviewer-facing summary (T071, FR-153).
 *
 * FR-153 is a requirement about an audience. The summary is not a changelog
 * and not a commit message: it is written for the engineer who has to decide
 * whether to merge something they did not write, and it has to answer the four
 * questions that decision actually turns on —
 *
 * 1. **What changed, and where**, per workspace entry (FR-114, FR-115). A
 *    multi-repo run produces a pull request per entry, and a reviewer looking
 *    at one of them needs to know the others exist.
 * 2. **The decisions and assumptions it made.** Every non-obvious choice a
 *    reviewer would otherwise have to reverse-engineer from a diff.
 * 3. **What it deliberately did not do.** The most valuable section and the
 *    one a model will omit unprompted, because "I left the migration alone on
 *    purpose" and "I forgot the migration" produce identical diffs and
 *    completely different reviews.
 * 4. **Where it was uncertain.** Where to look hardest.
 *
 * All four are structural here rather than advisory prose. A section with
 * nothing in it renders as an explicit statement that there is nothing in it,
 * never as a missing heading: a reviewer must be able to tell "it had no
 * reservations" from "it did not answer".
 *
 * The rendered summary is `SanitisedText`. It is assembled largely from
 * agent-authored strings and it goes two places a leak is permanent — the
 * panel and a pull request description — so it goes through the same
 * strip-then-redact pipeline as run output, at the one call site below
 * (FR-045, FR-089).
 */

import type { KnownSecret, SanitisedText, SegmentStore } from '../output'
import { sanitise } from '../output'

import type { MachineSurfaceClient } from './client'

/** What one workspace entry contributed, or why it contributed nothing. */
export interface EntrySummary {
  /** The workflow entry this describes, where the run knows it (FR-114). */
  readonly entryId?: string
  readonly repository: string
  /** Where under `/workspace` it was checked out (executor-protocol.md). */
  readonly subdirectory?: string
  /** False for an entry the run read but did not modify. */
  readonly changed: boolean
  /** What changed, or — when `changed` is false — why nothing did. */
  readonly description: string
  /** Notable paths, so a reviewer knows where to start. */
  readonly paths?: readonly string[]
  /** The pull request opened for this entry, once there is one (FR-115). */
  readonly pullRequestUrl?: string
}

export interface ReviewerSummaryInput {
  /** One per workspace entry, including the ones nothing happened to. */
  readonly entries: readonly EntrySummary[]
  readonly decisions: readonly string[]
  readonly assumptions: readonly string[]
  /** Deliberate omissions. Empty means "nothing was left out on purpose". */
  readonly notDone: readonly string[]
  readonly uncertainties: readonly string[]
  /** Every credential the setup bundle installed (FR-072). */
  readonly secrets?: readonly KnownSecret[]
}

export interface ReviewerSummary {
  readonly input: ReviewerSummaryInput
  /** Markdown, sanitised, ready for both the panel and a PR description. */
  readonly markdown: SanitisedText
}

/**
 * A summary that cannot answer FR-153's questions is not a summary.
 *
 * Refusing here is deliberate: the alternative is a pull request whose
 * description silently omits the section a reviewer most needs, and the
 * omission is invisible precisely because nothing renders.
 */
export const incompleteSummaryError = (problems: readonly string[]): Error =>
  new Error(`The reviewer summary is incomplete: ${problems.join('; ')}.`)

const isBlank = (value: string): boolean => value.trim() === ''

const validate = (input: ReviewerSummaryInput): readonly string[] => {
  const problems: string[] = []

  if (input.entries.length === 0) {
    problems.push('no workspace entry is described, so the reviewer cannot be told what changed')
  }

  for (const [index, entry] of input.entries.entries()) {
    if (isBlank(entry.repository)) {
      problems.push(`entry ${String(index)} does not name its repository`)
    }

    if (isBlank(entry.description)) {
      problems.push(
        `entry ${entry.repository || String(index)} has no description of what changed or why nothing did`,
      )
    }
  }

  return problems
}

const NOTHING_RECORDED = '_None recorded._'

const bulletList = (items: readonly string[]): string => {
  const kept = items.filter((item) => !isBlank(item))

  if (kept.length === 0) {
    return NOTHING_RECORDED
  }

  return kept.map((item) => `- ${item.trim()}`).join('\n')
}

const renderEntry = (entry: EntrySummary): string => {
  const heading =
    entry.subdirectory === undefined
      ? entry.repository
      : `${entry.repository} (\`${entry.subdirectory}\`)`
  const lines = [
    `### ${heading}`,
    '',
    entry.changed ? entry.description.trim() : `No changes. ${entry.description.trim()}`,
  ]

  if (entry.paths !== undefined && entry.paths.length > 0) {
    lines.push('', ...entry.paths.filter((path) => !isBlank(path)).map((path) => `- \`${path}\``))
  }

  if (entry.pullRequestUrl !== undefined) {
    lines.push('', `Pull request: ${entry.pullRequestUrl}`)
  }

  return lines.join('\n')
}

const renderMarkdown = (input: ReviewerSummaryInput): string =>
  [
    '## Summary for the reviewer',
    '',
    '## What changed, and where',
    '',
    input.entries.map(renderEntry).join('\n\n'),
    '',
    '## Decisions and assumptions',
    '',
    bulletList([...input.decisions, ...input.assumptions]),
    '',
    '## Deliberately not done',
    '',
    bulletList(input.notDone),
    '',
    '## Where this run was uncertain',
    '',
    bulletList(input.uncertainties),
    '',
  ].join('\n')

/**
 * Validate and render. The single place raw summary text is sanitised.
 *
 * @param input - The structured summary the run assembled.
 * @returns The summary with its sanitised markdown.
 */
export const buildReviewerSummary = (input: ReviewerSummaryInput): ReviewerSummary => {
  const problems = validate(input)

  if (problems.length > 0) {
    throw incompleteSummaryError(problems)
  }

  return {
    input,
    markdown: sanitise(
      renderMarkdown(input),
      input.secrets === undefined ? {} : { secrets: input.secrets },
    ),
  }
}

/**
 * Where a finished summary goes.
 *
 * Narrow on purpose, and shaped to the machine surface's eventual
 * `reportReviewerSummary` procedure rather than to today's transport, so the
 * summary's authors never depend on how it is delivered.
 */
export interface ReviewerSummarySink {
  readonly publish: (input: { readonly summary: SanitisedText }) => Promise<void>
}

export interface ArtifactSummarySinkOptions {
  readonly workflowId: string
  readonly client: Pick<MachineSurfaceClient, 'registerArtifact'>
  readonly store: SegmentStore
  /** Key prefix within the workflow's partition. */
  readonly keyPrefix?: string
}

/**
 * Deliver the summary as a stored `report` artifact.
 *
 * The machine surface exposes `registerArtifact` today and a dedicated
 * `reportReviewerSummary` later (api-surface.md). Both are reached through
 * {@link ReviewerSummarySink}, so when the procedure lands this adapter is
 * replaced and nothing that composes a summary changes.
 *
 * The body is written to storage before the row that points at it is
 * reported, for the same reason log segments are: a registered artifact naming
 * an object that does not exist is worse than no artifact.
 */
export const createArtifactSummarySink = (
  options: ArtifactSummarySinkOptions,
): ReviewerSummarySink => {
  const keyPrefix = options.keyPrefix ?? `workflows/${options.workflowId}`

  return {
    publish: async ({ summary }) => {
      const key = `${keyPrefix}/reviewer-summary.md`

      await options.store.put({ key, body: summary })
      await options.client.registerArtifact({
        kind: 'report',
        s3Key: key,
        byteSize: new TextEncoder().encode(summary).length,
      })
    },
  }
}

/**
 * Build, publish, and hand back the markdown for the pull request description.
 *
 * One call, because FR-153 requires both destinations and a run that did one
 * of them satisfies neither half of the requirement usefully.
 *
 * @param sink - Where the summary is recorded for the panel.
 * @param input - The structured summary the run assembled.
 * @returns The summary, whose markdown belongs in every PR description.
 */
export const publishReviewerSummary = async (
  sink: ReviewerSummarySink,
  input: ReviewerSummaryInput,
): Promise<ReviewerSummary> => {
  const summary = buildReviewerSummary(input)

  await sink.publish({ summary: summary.markdown })

  return summary
}
