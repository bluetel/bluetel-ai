/**
 * **Selecting the workflow type (T178, T174, FR-060, FR-061, FR-063, FR-064, FR-203).**
 *
 * Three workflow types are built and tested, and until this module existed all three were
 * reachable only from their barrel and their own tests. This is the one place that chooses between
 * them, and it chooses on `job.workflowType` from the envelope — the write-once value the launch
 * recorded (FR-149) — rather than on anything observed during the run.
 *
 * ## Why the ports are per type rather than one flat bag
 *
 * `runReviewWorkflow` has no developer port and `runDelegatedWorkflow` has no ticket port, and in
 * both cases that absence *is* the requirement: a review workflow makes no code changes (FR-063)
 * and a delegated one performs no ticket transition (FR-060), and both are guaranteed by there
 * being no argument through which it could happen. A single flattened input carrying every port
 * every type might need would throw all of that away — the compiler could no longer tell a
 * delegated run from an autonomous one, and "delegated runs never move a ticket" would go back to
 * being a rule somebody has to remember. So the three port bundles stay separate here and are
 * handed to the workflow whole.
 *
 * ## A type whose ports were not supplied halts, and says which
 *
 * {@link missingWorkflowPortsError} rather than a default. There is no substitute for an absent
 * agent boundary and nothing sensible to do without one, and the failure names the type and the
 * ports so an incomplete assembly is diagnosable from the terminal report rather than from a
 * stack trace. This is the same discipline `skills/resolve.ts` applies to a skill it cannot read.
 *
 * ## Every branch answers with an FR-064 outcome
 *
 * The three workflows have three different result shapes and one thing in common: each reaches
 * exactly one outcome from the closed set. {@link WorkflowDispatchResult} is that outcome, the
 * reason, and the type-specific result carried alongside for whatever wants the detail — so the
 * terminal report is built from one shape regardless of which workflow ran.
 */

import type { TerminalOutcome, WorkflowType } from '@bluetel-ai/sisyphus-api/client'

import type { AgentUsage } from '../agent'
import type { CapEnforcer } from '../caps'
import type { KnownSecret } from '../output'
import type { SkillReferenceReporter, SkillSource } from '../skills'
import type {
  AutonomousResult,
  AutonomousWorkflowInput,
  DelegatedResult,
  DelegatedWorkflowInput,
  ReviewWorkflowResult,
  RunReviewWorkflowInput,
} from '../workflows'
import { runAutonomousWorkflow, runDelegatedWorkflow, runReviewWorkflow } from '../workflows'

/** What every workflow type needs, whichever one the run is. */
export interface WorkflowCommonInput {
  readonly workflowId: string
  /** The primary entry's skills, and nowhere else (FR-110). */
  readonly source: SkillSource
  readonly report: SkillReferenceReporter
  readonly caps: CapEnforcer
  readonly usage: () => AgentUsage
  /** Credentials the setup bundle installed, so summaries can redact them (FR-072). */
  readonly secrets?: readonly KnownSecret[]
}

type CommonKeys = keyof WorkflowCommonInput

/** The delegated run's own ports — no ticket port, and that is FR-060. */
export type DelegatedPorts = Omit<DelegatedWorkflowInput, CommonKeys>

/** The autonomous loop's own ports. */
export type AutonomousPorts = Omit<AutonomousWorkflowInput, CommonKeys>

/** The review run's own ports — no developer port, and that is FR-063. */
export type ReviewPorts = Omit<RunReviewWorkflowInput, Exclude<CommonKeys, 'caps' | 'usage'>>

export interface WorkflowDispatchInput extends WorkflowCommonInput {
  /** From the envelope's write-once job spec, never inferred from the run (FR-149). */
  readonly workflowType: WorkflowType
  readonly delegated?: DelegatedPorts
  readonly autonomous?: AutonomousPorts
  readonly review?: ReviewPorts
}

export interface WorkflowDispatchResult {
  readonly workflowType: WorkflowType
  /** Exactly one of FR-064's closed set. */
  readonly outcome: TerminalOutcome
  readonly reason: string
  readonly delegated?: DelegatedResult
  readonly autonomous?: AutonomousResult
  readonly review?: ReviewWorkflowResult
}

/**
 * The halt for a type this assembly cannot run.
 *
 * Names the type and what was missing, and offers nothing that could be mistaken for a fallback —
 * running a delegated job as though it were something else would deliver work under the wrong
 * rules, which is worse than not running it.
 */
export const missingWorkflowPortsError = (workflowType: WorkflowType): Error =>
  new Error(
    `this executor was asked to run a ${workflowType} workflow and was assembled without the ` +
      `ports that workflow type needs. No other workflow type is substituted and nothing was ` +
      'attempted.',
  )

/**
 * Run whichever workflow the job spec named.
 *
 * @param input - The common context and the port bundle for each type this assembly can run.
 * @returns The FR-064 outcome, the reason, and the type-specific result.
 * @throws {Error} When the named type's ports were not supplied.
 */
export const dispatchWorkflow = async (
  input: WorkflowDispatchInput,
): Promise<WorkflowDispatchResult> => {
  const common: WorkflowCommonInput = {
    workflowId: input.workflowId,
    source: input.source,
    report: input.report,
    caps: input.caps,
    usage: input.usage,
    ...(input.secrets === undefined ? {} : { secrets: input.secrets }),
  }

  if (input.workflowType === 'delegated') {
    if (input.delegated === undefined) {
      throw missingWorkflowPortsError(input.workflowType)
    }

    const delegated = await runDelegatedWorkflow({ ...common, ...input.delegated })

    return {
      workflowType: input.workflowType,
      outcome: delegated.outcome,
      reason: delegated.reason,
      delegated,
    }
  }

  if (input.workflowType === 'autonomous') {
    if (input.autonomous === undefined) {
      throw missingWorkflowPortsError(input.workflowType)
    }

    const autonomous = await runAutonomousWorkflow({ ...common, ...input.autonomous })

    return {
      workflowType: input.workflowType,
      outcome: autonomous.outcome,
      reason: autonomous.reason,
      autonomous,
    }
  }

  if (input.review === undefined) {
    throw missingWorkflowPortsError(input.workflowType)
  }

  const review = await runReviewWorkflow({
    workflowId: common.workflowId,
    source: common.source,
    report: common.report,
    ...input.review,
  })

  return {
    workflowType: input.workflowType,
    outcome: review.outcome,
    reason: review.reason,
    review,
  }
}
