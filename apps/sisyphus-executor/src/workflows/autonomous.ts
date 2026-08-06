/**
 * The autonomous develop → review → integrate loop (T123, FR-057, FR-061, FR-062, FR-064,
 * FR-118).
 *
 * FR-061 states the sequence exactly: develop per `sisyphus-dev` → open a draft pull request →
 * move the ticket to review → review per `sisyphus-review` → on failure post feedback and return
 * the ticket to in progress → repeat, to a hard maximum of three iterations → on a passing review,
 * follow `sisyphus-integration`.
 *
 * ## Everything in that sentence that looks like a convention is one
 *
 * "Move the ticket to review" does not name a column, and "return the ticket to in progress" does
 * not either. Those are the client's board's words, not the platform's, and this file contains
 * neither — the states arrive as free text on a `SkillDirective`, and the skill is what named
 * them. The same is true of the branch, the base, the remote, the pull request title, its body,
 * whether it opens as a draft, and what happens after a passing review. Not one of them has a
 * default here, and `hardcoded-convention-scan.ts` is the test that keeps it that way: it reads
 * this directory's own source and fails on a literal that looks like a branch prefix, a target
 * branch, a pull request template or a board column.
 *
 * The likely way this file goes wrong is not a bug. It is somebody adding a fallback to make a
 * test pass against a repository whose skill was incomplete — which works, and ships, and quietly
 * proposes one client's changes onto a branch another client uses for something else.
 *
 * ## The bound is asked about, never counted
 *
 * The loop asks `nextOrdinal` for the next pass and stops when it answers `undefined`. There is no
 * counter here, and that is not stylistic: the count that matters is `iterations.ordinal` behind a
 * check constraint, because a run is snapshotted, restored and re-invoked, and every one of those
 * loses an in-memory count. See `iteration-record.ts`.
 *
 * ## Where it stops, it stops cleanly
 *
 * A cap reached mid-run stops at the next completed pass rather than mid-turn (FR-055) — the
 * enforcer only arms a stop and `checkBoundary` is what acts on it, so the workspace and the
 * conversation can always be snapshotted at the point the loop exits. Exhaustion goes through
 * `exhausted.ts` and reaches `needs_attention` with the history intact (FR-062). Both are outcomes
 * from FR-064's closed set, and the loop cannot fall off the end without one.
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
import type { ExhaustionReport } from './exhausted'
import { exhaustionReport, mustStopForAttention } from './exhausted'
import type {
  IntegrationOutcome,
  IntegrationPlanner,
  IntegrationPort,
  IntegrationStepRef,
  ResolvedIntegrationPlan,
} from './integration-step'
import { resolveIntegrationPlan, runIntegrationStep } from './integration-step'
import type { IterationHistory, IterationReporter } from './iteration-record'
import { nextOrdinal, recordIteration } from './iteration-record'
import type { ReviewSetAssessment } from './review-set'
import { reviewPullRequestSet } from './review-set'
import type { ReviewerPort, ReviewTarget } from './review-step'
import type { SkillDirective } from './skill-directive'
import type { TicketPort, TicketTransitionRecord, TicketTransitionRef } from './ticket'
import { transitionTicket } from './ticket'

/** The FR-064 outcomes this loop can reach. */
export type AutonomousOutcome = 'succeeded' | 'needs_attention' | 'capped'

/** One completed pass, as the loop remembers it. */
export interface AutonomousIteration {
  readonly ordinal: number
  readonly development: DevelopStepResult
  readonly pullRequests: PullRequestSet
  readonly assessment: ReviewSetAssessment
  /** Every ticket move this pass made, in order. Empty when the skills prescribed none. */
  readonly ticketMoves: readonly TicketTransitionRecord[]
}

export interface AutonomousResult {
  readonly outcome: AutonomousOutcome
  readonly reason: string
  readonly iterations: readonly AutonomousIteration[]
  readonly history: IterationHistory
  /** Present only after a passing review (FR-061). */
  readonly integration?: IntegrationOutcome
  /** Present only when the run used all three passes without one (FR-062). */
  readonly exhaustion?: ExhaustionReport
}

export interface AutonomousWorkflowInput {
  readonly workflowId: string
  /** The primary entry's skills, and nowhere else (FR-110). */
  readonly source: SkillSource
  readonly report: SkillReferenceReporter
  readonly developer: DeveloperPort
  readonly reviewer: ReviewerPort
  readonly planner: IntegrationPlanner
  readonly integrator: IntegrationPort
  /** Every workspace entry, with what the delivery step needs to verify a push. */
  readonly entries: readonly PullRequestSetEntry[]
  readonly ticketReference?: string
  readonly ticket?: TicketPort
  readonly caps: CapEnforcer
  readonly usage: () => AgentUsage
  readonly recordIteration: IterationReporter
  readonly pullRequestLedger?: ExternalActionLedger<PullRequestDelivery>
  readonly ticketLedger: ExternalActionLedger<TicketTransitionRef>
  readonly integrationLedger: ExternalActionLedger<IntegrationStepRef>
  /** Credentials the setup bundle installed, so the summary can redact them (FR-072). */
  readonly secrets?: readonly KnownSecret[]
}

/** The pull requests this pass opened, as the reviewer needs to see them. */
const targetsFrom = (set: PullRequestSet): readonly ReviewTarget[] =>
  set.members.flatMap((member) =>
    member.pullRequest === undefined
      ? []
      : [
          {
            entryId: member.entryId,
            repository: member.repository,
            pullRequestNumber: member.pullRequest.number,
            pullRequestUrl: member.pullRequest.url,
          },
        ],
  )

interface PrescribedMove {
  readonly toState: string
  readonly directive: SkillDirective
}

/**
 * Move the ticket, but only where a skill prescribed it.
 *
 * Answers `undefined` when the step produced no directive — which is how a client whose board has
 * no review column gets a run that leaves the ticket where it is, rather than one that invents a
 * column for it. A run with no ticket at all is the same case.
 */
const moveTicketIfPrescribed = async (
  input: AutonomousWorkflowInput,
  prescribed: PrescribedMove | undefined,
): Promise<TicketTransitionRecord | undefined> => {
  const { ticketReference, ticket } = input

  if (prescribed === undefined || ticketReference === undefined || ticket === undefined) {
    return undefined
  }

  return transitionTicket({
    workflowId: input.workflowId,
    ticketReference,
    toState: prescribed.toState,
    directive: prescribed.directive,
    ticket,
    ledger: input.ticketLedger,
  })
}

const summaryFor = (
  development: DevelopStepResult,
  secrets: readonly KnownSecret[],
): ReviewerSummary => buildReviewerSummary({ ...development.summary, secrets })

/**
 * Resolve the integration plan when the workspace needs one before delivery.
 *
 * A multi-repository run has to know the promotion order the moment it opens the set, because the
 * order goes into every pull request's cross-reference (FR-116, FR-117). A single-entry run does
 * not: one permutation of one repository chooses nothing, so `sisyphus-integration` is not needed
 * until the integrate step and is not read before it (FR-058 resolves a skill at the point it is
 * needed, not speculatively).
 */
const planIfNeeded = async (
  input: AutonomousWorkflowInput,
): Promise<ResolvedIntegrationPlan | undefined> =>
  input.entries.length > 1 ? resolveIntegrationPlan(input) : undefined

/**
 * Run the autonomous loop.
 *
 * @param input - The skills, the four agent-facing ports, the caps and the ledgers.
 * @returns Exactly one FR-064 outcome, with every pass recorded.
 */
export const runAutonomousWorkflow = async (
  input: AutonomousWorkflowInput,
): Promise<AutonomousResult> => {
  const iterations: AutonomousIteration[] = []
  const resolvedPlan = await planIfNeeded(input)
  let history: IterationHistory = []

  for (;;) {
    const ordinal = nextOrdinal(history)

    if (ordinal === undefined) {
      break
    }

    const development = await runDevelopStep({
      ordinal,
      source: input.source,
      report: input.report,
      developer: input.developer,
      feedback: iterations.at(-1)?.assessment.findings ?? [],
    })

    const pullRequests = await openPullRequestSet({
      workflowId: input.workflowId,
      conventions: development.conventions,
      entries: input.entries,
      summary: summaryFor(development, input.secrets ?? []),
      ...(resolvedPlan?.plan.order === undefined
        ? {}
        : { promotionOrder: resolvedPlan.plan.order }),
      ...(input.pullRequestLedger === undefined ? {} : { ledger: input.pullRequestLedger }),
    })

    const ticketMoves: TicketTransitionRecord[] = []
    const afterDraft = await moveTicketIfPrescribed(input, development.ticket)

    if (afterDraft !== undefined) {
      ticketMoves.push(afterDraft)
    }

    const assessment = await reviewPullRequestSet({
      ordinal,
      source: input.source,
      report: input.report,
      reviewer: input.reviewer,
      targets: targetsFrom(pullRequests),
    })

    history = await recordIteration(
      history,
      { ordinal, verdict: assessment.verdict, findings: assessment.findings },
      input.recordIteration,
    )

    // The failure path's ticket move is the same call as the success path's: what the ticket does
    // after a failing review is `sisyphus-review`'s to say, and "return it to in progress" is that
    // skill's wording rather than a state named here.
    const afterReview = await moveTicketIfPrescribed(input, assessment.ticket)

    if (afterReview !== undefined) {
      ticketMoves.push(afterReview)
    }

    iterations.push({ ordinal, development, pullRequests, assessment, ticketMoves })

    if (assessment.verdict === 'pass') {
      const integration = await runIntegrationStep({
        workflowId: input.workflowId,
        source: input.source,
        report: input.report,
        planner: input.planner,
        integrator: input.integrator,
        entries: input.entries.map((entry) => ({ entryId: entry.entryId })),
        ledger: input.integrationLedger,
        ...(resolvedPlan === undefined ? {} : { resolved: resolvedPlan }),
      })

      const finished = integration.results.length === 0 || integration.complete

      return {
        outcome: finished ? 'succeeded' : 'needs_attention',
        reason: `Review passed on iteration ${String(ordinal)}. ${integration.statement}`,
        iterations,
        history,
        integration,
      }
    }

    // The only safe place to stop on a cap: a completed pass, with the workspace and the
    // conversation in a state the ordinary suspend path can snapshot (FR-055).
    const decision = input.caps.checkBoundary(input.usage())

    if (decision.action === 'stop') {
      return { outcome: 'capped', reason: decision.report.reason, iterations, history }
    }
  }

  if (!mustStopForAttention(history)) {
    throw new Error(
      'The autonomous loop ended without a verdict, a cap or an exhausted history. That is not ' +
        'one of FR-064’s outcomes, and a run must never exit leaving its state unrecorded (FR-056).',
    )
  }

  const exhaustion = exhaustionReport(history)

  return { outcome: exhaustion.outcome, reason: exhaustion.reason, iterations, history, exhaustion }
}
