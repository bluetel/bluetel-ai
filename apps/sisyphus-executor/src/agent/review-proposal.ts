/**
 * Reading a {@link ReviewProposal} out of what the agent actually wrote (T196, FR-063, FR-119).
 *
 * The counterpart of `development-proposal.ts`, and it holds the same line: a field the block does
 * not carry is left off, never inferred and never given a plausible value. What differs is where
 * the halts live, and the difference is deliberate.
 *
 * ## Two absences this module deliberately does not raise
 *
 * **A missing verdict** and **a failing verdict with no findings** are both refused — by
 * `runReviewStep`, which names `sisyphus-review`, its resolved path and its digest, which is what
 * FR-058 asks for and is more use to an operator than anything this module could say about a JSON
 * key. So a block with no verdict produces a proposal with no verdict, and the step stops where it
 * was always going to stop.
 *
 * ## One absence it does raise, because nobody downstream can
 *
 * **A finding that is not a finding.** `IterationFinding` is the platform's `reviewFindingInput`:
 * a severity from a closed set and a summary that says something. A finding whose severity is a
 * word the agent invented, or whose summary is blank, cannot be recorded — and the two ways of
 * dealing with that quietly are both worse than halting. Dropping it loses a blocker, which is the
 * single most expensive thing a review can lose. Coercing it — `severity: 'info'` for an
 * unrecognised word — files a blocker as a note, which is the same loss with a paper trail saying
 * it was handled.
 *
 * The anchor is checked no further than its shape. Whether `workflowEntryId` names a repository
 * this run actually has is `review-set.ts`'s question, and it already halts on it
 * (`unknownEntryFindingError`); asking here as well would put the same rule in two places and let
 * them disagree.
 */

import { REVIEW_FINDING_SEVERITIES } from '@bluetel-ai/sisyphus-api/client'

import type { IterationFinding, ReviewProposal } from '../workflows'

/** The keys a review block can carry. A block with none of them has answered nothing. */
export const REVIEW_KEYS = [
  'verdict',
  'findings',
  'comment',
  'ticketInstruction',
  'ticketState',
] as const

/** What the block turned out to be. */
export type ReviewProposalReading =
  /** Everything the agent stated, and only that. May still lack a verdict; see the note above. */
  | { readonly kind: 'read'; readonly proposal: ReviewProposal }
  /** Well-formed and carrying none of the fields a review is made of. */
  | { readonly kind: 'empty' }
  /** Something is there and cannot be used. Every problem is named. */
  | { readonly kind: 'unusable'; readonly problems: readonly string[] }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readText = (source: Record<string, unknown>, key: string): string | undefined => {
  const value = source[key]

  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

const isSeverity = (value: unknown): value is IterationFinding['severity'] =>
  typeof value === 'string' && (REVIEW_FINDING_SEVERITIES as readonly string[]).includes(value)

/**
 * Read one finding, or say why it is not one.
 *
 * `line` is accepted only as a positive integer because that is what the platform's schema takes;
 * a line number of `0` or `"12"` would be rejected at the surface, several minutes later, as a
 * validation error about a field nobody would connect back to the review.
 */
const readFinding = (
  value: unknown,
  index: number,
  problems: string[],
): IterationFinding | undefined => {
  const where = `finding ${String(index)}`

  if (!isRecord(value)) {
    problems.push(`${where} is not an object`)

    return undefined
  }

  const summary = readText(value, 'summary')
  const severity = value['severity']

  if (!isSeverity(severity)) {
    problems.push(
      `${where} states a severity of ${JSON.stringify(severity)}, which is not one of ` +
        `${REVIEW_FINDING_SEVERITIES.join(', ')}. It is not recorded as anything else — a blocker ` +
        'filed as a note is a blocker lost',
    )
  }

  if (summary === undefined) {
    problems.push(`${where} says nothing; a finding with no summary cannot be acted on`)
  }

  const line = value['line']
  const hasLine = line !== undefined

  if (hasLine && (typeof line !== 'number' || !Number.isInteger(line) || line < 1)) {
    problems.push(`${where} states a line that is not a positive whole number`)

    return undefined
  }

  if (!isSeverity(severity) || summary === undefined) {
    return undefined
  }

  const filePath = readText(value, 'filePath')
  const workflowEntryId = readText(value, 'workflowEntryId')

  return {
    severity,
    summary,
    ...(filePath === undefined ? {} : { filePath }),
    ...(workflowEntryId === undefined ? {} : { workflowEntryId }),
    ...(typeof line === 'number' ? { line } : {}),
  }
}

const readVerdict = (value: unknown, problems: string[]): ReviewProposal['verdict'] => {
  if (value === undefined) {
    return undefined
  }

  if (value === 'pass' || value === 'fail') {
    return value
  }

  problems.push(
    `the verdict is ${JSON.stringify(value)}, which is neither "pass" nor "fail". An undecided ` +
      'review is not a pass, and it is not read as one here',
  )

  return undefined
}

const readFindings = (
  value: unknown,
  problems: string[],
): readonly IterationFinding[] | undefined => {
  if (value === undefined) {
    return undefined
  }

  if (!Array.isArray(value)) {
    problems.push('findings is present but is not a list')

    return undefined
  }

  const read = value.map((finding, index) => readFinding(finding, index, problems))

  return read.every((finding): finding is IterationFinding => finding !== undefined)
    ? read
    : undefined
}

/**
 * Turn a block's JSON object into a review proposal, or say why it is not one.
 *
 * @param value - The object `extractBlock` found. Trusted to be an object and nothing else.
 * @returns The proposal, the fact that the block said nothing, or every problem in it.
 */
export const readReviewProposal = (value: Record<string, unknown>): ReviewProposalReading => {
  if (!REVIEW_KEYS.some((key) => value[key] !== undefined)) {
    return { kind: 'empty' }
  }

  const problems: string[] = []
  const verdict = readVerdict(value['verdict'], problems)
  const findings = readFindings(value['findings'], problems)

  if (problems.length > 0) {
    return { kind: 'unusable', problems }
  }

  const comment = readText(value, 'comment')
  const ticketInstruction = readText(value, 'ticketInstruction')
  const ticketState = readText(value, 'ticketState')

  return {
    kind: 'read',
    proposal: {
      // Every one of these is left off when the agent did not state it. `runReviewStep` decides
      // what an absence means, and it halts naming the skill rather than defaulting (FR-058).
      ...(verdict === undefined ? {} : { verdict }),
      ...(findings === undefined ? {} : { findings }),
      ...(comment === undefined ? {} : { comment }),
      ...(ticketInstruction === undefined ? {} : { ticketInstruction }),
      ...(ticketState === undefined ? {} : { ticketState }),
    },
  }
}
