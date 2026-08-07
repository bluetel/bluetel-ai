/**
 * The **delegated** workflow type — US1's run, end to end (T174, FR-060, FR-064, FR-115, FR-118).
 *
 * One development pass per `sisyphus-dev`, one draft pull request per changed entry, and then it
 * stops. That is the whole shape, and every clause of it is FR-060: the engineer delegated the
 * work, not the delivery, so what comes back is a proposal they still own.
 *
 * ## "No ticket transition" is a shape, not a promise
 *
 * `review.ts` makes the same move for "makes no code changes" and for the same reason. There is no
 * `ticket` port on {@link DelegatedWorkflowInput}, no `ticketReference`, and no ledger for one —
 * so a delegated run cannot move a ticket, and a future edit that wanted to would have to widen
 * this signature, which is a conspicuous diff rather than a line nobody reads. `movedTicket:
 * false` on the result is the positive statement of the same fact, so the panel can say the ticket
 * was left alone deliberately instead of leaving a reader to infer it from an absence (SC-009).
 *
 * The same applies to review. There is no reviewer port here: an autonomous run reviews its own
 * work because nobody else is going to, and a delegated run does not because somebody is — the
 * engineer who asked for it. Adding one would not be an improvement, it would be a different
 * workflow type.
 *
 * ## Draft unless the request said otherwise
 *
 * FR-060's one conditional. {@link DelegatedWorkflowInput.readyForReview} carries what the
 * *launch request* said, and it is `undefined` on every run that did not say anything — which
 * `openPullRequestSet` reads as a draft. The default is therefore an absence rather than a
 * `false` somebody could flip, and there is no path by which a skill, a convention or this module
 * could open a non-draft pull request that the person launching the run did not ask for.
 *
 * ## Everything that looks like a convention is one
 *
 * Branch, base, remote, title, description: none of them appears in this file, because all of them
 * are `sisyphus-dev`'s, arriving on a {@link SkillDirective} with the digest of the file that
 * stated them. `hardcoded-convention-scan.ts` reads this directory's source on every test run and
 * fails on a literal that looks like one.
 *
 * ## One pass, so the cap is asked once
 *
 * There is no loop here and so no iteration bound — a delegated run is a single pass by
 * definition, and `iterations.ordinal` belongs to the autonomous loop that actually has passes to
 * count. The cap enforcer is still consulted, at the one boundary this workflow has: after the
 * pass has completed and delivery has been attempted. A cap reached during the pass stops the run
 * *there* rather than mid-turn (FR-055), and the consumption figures go out with the terminal
 * report either way.
 */

import type { AgentUsage } from '../agent'
import type { CapEnforcer } from '../caps'
import type {
  ExternalActionLedger,
  PullRequestDelivery,
  PullRequestSet,
  PullRequestSetEntry,
} from '../delivery'
import { openPullRequestSet } from '../delivery'
import type { KnownSecret } from '../output'
import type { ReviewerSummary } from '../report'
import { buildReviewerSummary } from '../report'
import type { SkillReferenceReporter, SkillSource } from '../skills'

import type { DeveloperPort, DevelopStepResult } from './develop-step'
import { runDevelopStep } from './develop-step'
import type { IntegrationPlanner, ResolvedIntegrationPlan } from './integration-step'
import { resolveIntegrationPlan } from './integration-step'

/**
 * The pass number a delegated run reports against.
 *
 * A delegated run has exactly one, and it is named rather than written inline so the reason it is
 * not a counter is visible: nothing here increments it.
 */
export const DELEGATED_PASS = 1

/** The FR-064 outcomes this workflow type can reach. */
export type DelegatedOutcome = 'succeeded' | 'needs_attention' | 'capped'

export interface DelegatedResult {
  readonly outcome: DelegatedOutcome
  readonly reason: string
  readonly development: DevelopStepResult
  readonly pullRequests: PullRequestSet
  /** Always false — this workflow type has nothing to move a ticket with (FR-060). */
  readonly movedTicket: false
}

export interface DelegatedWorkflowInput {
  readonly workflowId: string
  /** The primary entry's skills, and nowhere else (FR-110). */
  readonly source: SkillSource
  readonly report: SkillReferenceReporter
  readonly developer: DeveloperPort
  /** Every workspace entry, with what the delivery step needs to verify a push. */
  readonly entries: readonly PullRequestSetEntry[]
  /**
   * Reads the promotion order out of `sisyphus-integration`.
   *
   * Needed only for a workspace with a second entry, where the order goes into every pull
   * request's cross-reference the moment the set is opened (FR-116, FR-117). A delegated run
   * integrates nothing, so this is the *only* thing the integration skill is asked for here.
   * Omitted on a multi-entry run, the set halts naming the skill rather than choosing an order
   * across the client's repositories.
   */
  readonly planner?: IntegrationPlanner
  readonly caps: CapEnforcer
  readonly usage: () => AgentUsage
  readonly pullRequestLedger?: ExternalActionLedger<PullRequestDelivery>
  /** Credentials the setup bundle installed, so the summary can redact them (FR-072). */
  readonly secrets?: readonly KnownSecret[]
  /** What the launch request said about readiness. Absent means draft (FR-060). */
  readonly readyForReview?: boolean
}

const summaryFor = (
  development: DevelopStepResult,
  secrets: readonly KnownSecret[],
): ReviewerSummary => buildReviewerSummary({ ...development.summary, secrets })

/**
 * Resolve the promotion order when the workspace spans more than one repository.
 *
 * Identical in shape to `autonomous.ts`'s, and deliberately so: a single-entry run chooses nothing
 * between one permutation of one repository, so `sisyphus-integration` is not read for it (FR-058
 * resolves a skill at the point it is needed, not speculatively).
 */
const planIfNeeded = async (
  input: DelegatedWorkflowInput,
): Promise<ResolvedIntegrationPlan | undefined> => {
  const { planner } = input

  return input.entries.length > 1 && planner !== undefined
    ? resolveIntegrationPlan({ source: input.source, report: input.report, planner })
    : undefined
}

/**
 * Which of FR-064's outcomes a completed pass reached, and why.
 *
 * Delivery failures come first. A set that could not open everything it meant to needs a person
 * looking at it, and saying "capped" about a run whose real problem is an unopened pull request
 * sends that person to the wrong place — the consumption figures reach the terminal report
 * regardless of which outcome is chosen here.
 */
const settle = (
  pullRequests: PullRequestSet,
  input: DelegatedWorkflowInput,
): { readonly outcome: DelegatedOutcome; readonly reason: string } => {
  const opened = pullRequests.members.filter((member) => member.outcome === 'opened').length
  const unchanged = pullRequests.members.filter((member) => member.outcome === 'unchanged').length

  if (pullRequests.failed.length > 0) {
    const where = pullRequests.failed
      .map((member) => `${member.repository}: ${member.reason ?? 'no reason recorded'}`)
      .join('; ')

    return {
      outcome: 'needs_attention',
      reason:
        `${String(opened)} of ${String(pullRequests.members.length)} entries produced a pull ` +
        `request and ${String(pullRequests.failed.length)} did not (${where}). This is a ` +
        'partial result, not a success (FR-118).',
    }
  }

  const decision = input.caps.checkBoundary(input.usage())

  if (decision.action === 'stop') {
    return { outcome: 'capped', reason: decision.report.reason }
  }

  return {
    outcome: 'succeeded',
    reason:
      `Delegated pass complete: ${String(opened)} pull request(s) proposed on ` +
      `${pullRequests.branchName} and ${String(unchanged)} entries unchanged. The ticket was not ` +
      'moved and delivery remains with the engineer who asked for the run (FR-060).',
  }
}

/**
 * Run a delegated workflow: develop once, propose, stop.
 *
 * @param input - The skills, the developer port, the workspace entries and the caps.
 * @returns Exactly one FR-064 outcome, with the pass and every entry's delivery result.
 * @throws When `sisyphus-dev` cannot be used or came back incomplete (FR-058), or when a
 *   multi-repository workspace has no declared promotion order (FR-117). A failure *within* an
 *   entry is recorded against that entry and reaches `needs_attention` instead.
 */
export const runDelegatedWorkflow = async (
  input: DelegatedWorkflowInput,
): Promise<DelegatedResult> => {
  const resolvedPlan = await planIfNeeded(input)

  const development = await runDevelopStep({
    ordinal: DELEGATED_PASS,
    source: input.source,
    report: input.report,
    developer: input.developer,
    // Nothing has reviewed anything yet, and nothing will: a delegated run has no earlier pass to
    // carry findings from and no reviewer to produce them.
    feedback: [],
  })

  const pullRequests = await openPullRequestSet({
    workflowId: input.workflowId,
    conventions: development.conventions,
    entries: input.entries,
    summary: summaryFor(development, input.secrets ?? []),
    ...(resolvedPlan?.plan.order === undefined ? {} : { promotionOrder: resolvedPlan.plan.order }),
    ...(input.readyForReview === undefined ? {} : { readyForReview: input.readyForReview }),
    ...(input.pullRequestLedger === undefined ? {} : { ledger: input.pullRequestLedger }),
  })

  return { ...settle(pullRequests, input), development, pullRequests, movedTicket: false }
}
