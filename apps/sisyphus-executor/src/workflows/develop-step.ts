/**
 * One development pass of the autonomous loop (T123, FR-057, FR-058, FR-061).
 *
 * The step is three things in a fixed order, and the order is the requirement:
 *
 * 1. **Resolve `sisyphus-dev` from the primary entry**, reporting its digest (FR-059) and halting
 *    if it is missing, unreadable or self-contradictory (FR-058). Nothing is attempted before
 *    this, so a repository with no skill produces a halt rather than a branch.
 * 2. **Hand the skill to the agent.** The executor composes no instruction of its own about how to
 *    branch, what to base on or what a pull request should say — it passes the skill body through
 *    and the feedback from the previous pass, and the agent does the reading. A prompt assembled
 *    here that said anything about branch naming would be the hardcoding FR-057 forbids, one
 *    remove away from a constant.
 * 3. **Insist the answer is complete** via `requireDeliveryConventions`, which halts naming the
 *    skill and the step when the agent came back without a base branch or with a branch proposed
 *    onto itself. There is no field this step will fill in.
 *
 * What comes back is attached to a {@link SkillDirective}, so the conventions this pass acts on
 * carry the digest of the file that stated them all the way to the pull request.
 */

import type { DeliveryConventions } from '../delivery'
import { requireDeliveryConventions } from '../delivery'
import type { ReviewerSummaryInput } from '../report'
import type { ResolvedSkill, SkillReferenceReporter, SkillSource } from '../skills'
import { resolveSkill } from '../skills'

import type { IterationFinding } from './iteration-record'
import type { SkillDirective } from './skill-directive'
import { directiveFrom } from './skill-directive'

/** The skill every development convention is read from. */
export const DEV_SKILL = 'sisyphus-dev'

/**
 * The step named in a halt, per FR-058.
 *
 * Two words rather than one, matching `DELIVERY_STEP`'s phrasing — and because a one-word step
 * called after a branch name is a literal `hardcoded-convention-scan.ts` cannot tell from a
 * hardcoded target branch, and weakening that scan to accommodate a constant here would be the
 * wrong trade.
 */
export const DEVELOP_STEP = 'development pass'

/** What the agent is given: the skill, and what the last review said. */
export interface DevelopmentRequest {
  readonly ordinal: number
  /** `sisyphus-dev`, as it was actually read. The body is the instruction. */
  readonly skill: ResolvedSkill
  /** Findings the previous pass must address. Empty on the first pass. */
  readonly feedback: readonly IterationFinding[]
}

/**
 * What the agent came back with, possibly incomplete.
 *
 * Deliberately `Partial`: the agent may have failed to read a convention out of the skill, and the
 * type is what makes that a case this step has to handle rather than one it can assume away.
 */
export interface DevelopmentProposal {
  readonly conventions: Partial<DeliveryConventions>
  readonly summary: ReviewerSummaryInput
  /**
   * What the skill says to do with the ticket once the draft pull request is open, in the skill's
   * own words, or nothing if it says nothing. There is no default: a skill that is silent about
   * the ticket leaves the ticket alone.
   */
  readonly ticketInstruction?: string
  /** The state the skill named. Free text; Sisyphus has no board columns of its own. */
  readonly ticketState?: string
  /** True when the pass produced no change at all — a legitimate outcome, not a failure. */
  readonly wasChanged?: boolean
}

/** The port the agent boundary satisfies. */
export type DeveloperPort = (request: DevelopmentRequest) => Promise<DevelopmentProposal>

export interface DevelopStepInput {
  readonly ordinal: number
  readonly source: SkillSource
  readonly report: SkillReferenceReporter
  readonly developer: DeveloperPort
  readonly feedback: readonly IterationFinding[]
}

export interface DevelopStepResult {
  readonly ordinal: number
  readonly skill: ResolvedSkill
  /** Complete, validated, and entirely the skill's (FR-057). */
  readonly conventions: DeliveryConventions
  readonly summary: ReviewerSummaryInput
  readonly wasChanged: boolean
  /** The directive the delivery step acts under. */
  readonly directive: SkillDirective
  /**
   * What to do with the ticket after the draft pull request, or `undefined` when the skill said
   * nothing. `undefined` means the ticket is not moved — never a state chosen here.
   */
  readonly ticket?: { readonly toState: string; readonly directive: SkillDirective }
}

/**
 * Run one development pass.
 *
 * @param input - The pass number, where the skills are, and the agent boundary.
 * @returns Complete delivery conventions and the summary the reviewer will read.
 * @throws When `sisyphus-dev` cannot be used, or when what came back is incomplete.
 */
export const runDevelopStep = async (input: DevelopStepInput): Promise<DevelopStepResult> => {
  const skill = await resolveSkill(DEV_SKILL, {
    source: input.source,
    step: DEVELOP_STEP,
    report: input.report,
  })

  const proposal = await input.developer({
    ordinal: input.ordinal,
    skill,
    feedback: input.feedback,
  })

  const conventions = requireDeliveryConventions(proposal.conventions, DEVELOP_STEP)

  const directive = directiveFrom(skill, {
    step: DEVELOP_STEP,
    instruction: `Propose ${conventions.branchName} onto ${conventions.baseBranch} at ${conventions.remote}.`,
  })

  const ticketInstruction = proposal.ticketInstruction?.trim() ?? ''
  const ticketState = proposal.ticketState?.trim() ?? ''

  return {
    ordinal: input.ordinal,
    skill,
    conventions,
    summary: proposal.summary,
    wasChanged: proposal.wasChanged ?? true,
    directive,
    ...(ticketInstruction === '' || ticketState === ''
      ? {}
      : {
          ticket: {
            toState: ticketState,
            directive: directiveFrom(skill, {
              step: DEVELOP_STEP,
              instruction: ticketInstruction,
            }),
          },
        }),
  }
}
