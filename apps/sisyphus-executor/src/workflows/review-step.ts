/**
 * One review pass, per `sisyphus-review` (T128, FR-057, FR-058, FR-061, FR-063, FR-119).
 *
 * Shared by both callers on purpose. The autonomous loop's review and the standalone review
 * workflow are the **same** evaluation — same skill, same rubric, same verdict vocabulary — and
 * the only difference is what happens afterwards: the loop feeds a failure back into another
 * development pass, the standalone workflow posts and stops. Two implementations of "review per
 * the skill" would drift, and the drift would show up as an autonomous run and a manual review of
 * the same pull request disagreeing.
 *
 * ## The rubric is not here
 *
 * There is no list of things to check anywhere in this file. What counts as a blocker is the
 * client's business and it is stated in `sisyphus-review`; the body is handed to the agent
 * verbatim. A severity ladder baked in here would be Sisyphus's opinion applied to every client's
 * code (FR-057).
 *
 * ## Two self-contradictions this step refuses
 *
 * `sisyphus-review` can be present and readable and still leave the step unable to act, and both
 * cases halt per FR-058 rather than being smoothed over:
 *
 * - **No verdict.** A review that did not decide is not a pass. Treating a missing verdict as a
 *   pass would merge unreviewed work; treating it as a failure would burn an iteration on a review
 *   that never happened.
 * - **A failure that names nothing.** The next development pass is driven entirely by the findings,
 *   so a failing verdict with an empty list leaves the loop with nothing to act on and guarantees
 *   an identical failure on the next pass. That is a contradiction in what the skill produced, and
 *   it halts naming the skill.
 */

import type { ResolvedSkill, SkillReferenceReporter, SkillSource } from '../skills'
import { haltForSkill, resolveSkill } from '../skills'

import type { IterationFinding, IterationVerdict } from './iteration-record'
import type { SkillDirective } from './skill-directive'
import { directiveFrom } from './skill-directive'

/** The skill the rubric is read from. */
export const REVIEW_SKILL = 'sisyphus-review'

/** The step named in a halt, per FR-058. */
export const REVIEW_STEP = 'review'

/** One pull request the review is about. */
export interface ReviewTarget {
  /** The workspace entry it belongs to, so findings can be anchored (FR-119). */
  readonly entryId: string
  readonly repository: string
  readonly pullRequestNumber: number
  readonly pullRequestUrl: string
}

/** What the agent is given. */
export interface ReviewRequest {
  readonly ordinal?: number
  /** `sisyphus-review`, as it was actually read. The body is the rubric. */
  readonly skill: ResolvedSkill
  /**
   * Every pull request under review, always as a set. A single-entry run is a set of one, which is
   * what stops the multi-entry case (FR-119) from being a separate code path.
   */
  readonly targets: readonly ReviewTarget[]
}

/** What the agent came back with, possibly undecided. */
export interface ReviewProposal {
  readonly verdict?: IterationVerdict
  readonly findings?: readonly IterationFinding[]
  /** What the skill says to do with the ticket, in its own words, or nothing. */
  readonly ticketInstruction?: string
  /** The state the skill named. Free text; Sisyphus has no board columns of its own. */
  readonly ticketState?: string
  /** The comment the skill says to post, composed by the agent. */
  readonly comment?: string
}

export type ReviewerPort = (request: ReviewRequest) => Promise<ReviewProposal>

export interface ReviewStepInput {
  readonly ordinal?: number
  readonly source: SkillSource
  readonly report: SkillReferenceReporter
  readonly reviewer: ReviewerPort
  readonly targets: readonly ReviewTarget[]
}

/** One review, decided. */
export interface ReviewAssessment {
  readonly skill: ResolvedSkill
  readonly verdict: IterationVerdict
  readonly findings: readonly IterationFinding[]
  readonly targets: readonly ReviewTarget[]
  /** The comment to post, or `undefined` when the skill prescribed none. */
  readonly comment?: string
  readonly directive: SkillDirective
  /** What to do with the ticket, or `undefined` when the skill said nothing. */
  readonly ticket?: { readonly toState: string; readonly directive: SkillDirective }
}

/**
 * Review the targets against `sisyphus-review`.
 *
 * @param input - Where the skills are, the agent boundary, and every pull request under review.
 * @returns One verdict over the whole set, with its findings.
 * @throws When `sisyphus-review` cannot be used, or leaves the step unable to act.
 */
export const runReviewStep = async (input: ReviewStepInput): Promise<ReviewAssessment> => {
  const skillOptions = { source: input.source, step: REVIEW_STEP, report: input.report }
  const skill = await resolveSkill(REVIEW_SKILL, skillOptions)

  if (input.targets.length === 0) {
    throw new Error(
      `The ${REVIEW_STEP} step has nothing to review: no pull request was given. The workflow ` +
        'stops here rather than recording a verdict about nothing.',
    )
  }

  const proposal = await input.reviewer({
    ...(input.ordinal === undefined ? {} : { ordinal: input.ordinal }),
    skill,
    targets: input.targets,
  })

  if (proposal.verdict === undefined) {
    // Returned rather than awaited: `haltForSkill` answers `Promise<never>`, so returning it makes
    // the rest of this function unreachable to the compiler as well as to the reader — which is
    // what lets the verdict below be read without a fallback that would look like a default.
    return haltForSkill(REVIEW_SKILL, {
      ...skillOptions,
      resolvedPath: skill.resolvedPath,
      reason:
        'the review produced no verdict. An undecided review is neither a pass nor a failure, ' +
        'and treating it as either would either merge unreviewed work or spend an iteration on a ' +
        'review that never happened',
    })
  }

  const findings = proposal.findings ?? []

  if (proposal.verdict === 'fail' && findings.length === 0) {
    return haltForSkill(REVIEW_SKILL, {
      ...skillOptions,
      resolvedPath: skill.resolvedPath,
      reason:
        'the review failed and named nothing to fix. The next development pass is driven entirely ' +
        'by the findings, so an empty list guarantees an identical failure on the next pass',
    })
  }

  const directive = directiveFrom(skill, {
    step: REVIEW_STEP,
    instruction: `Verdict "${proposal.verdict}" over ${String(input.targets.length)} pull request(s).`,
  })

  const ticketInstruction = proposal.ticketInstruction?.trim() ?? ''
  const ticketState = proposal.ticketState?.trim() ?? ''
  const comment = proposal.comment?.trim() ?? ''

  return {
    skill,
    verdict: proposal.verdict,
    findings,
    targets: input.targets,
    directive,
    ...(comment === '' ? {} : { comment }),
    ...(ticketInstruction === '' || ticketState === ''
      ? {}
      : {
          ticket: {
            toState: ticketState,
            directive: directiveFrom(skill, { step: REVIEW_STEP, instruction: ticketInstruction }),
          },
        }),
  }
}
