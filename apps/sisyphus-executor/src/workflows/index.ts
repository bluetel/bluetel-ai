/**
 * The workflow types — autonomous (US4) and review (US5) (T123–T126, T128–T131).
 *
 * Consumers import this barrel, never a module underneath it. Three things it is holding in place,
 * each structural rather than a matter of care:
 *
 * - **Nothing here holds a convention of its own.** No branch prefix, no target branch, no pull
 *   request template, no ticket state. Every one of them arrives on a `SkillDirective` carrying
 *   the digest of the skill that stated it, and `hardcoded-convention-scan.ts` reads this
 *   directory's source on every test run and fails on a literal that looks like one (FR-057).
 * - **A ticket moves only where a skill said to.** `transitionTicket` is the single route, and it
 *   refuses without a directive. A delegated run never reaches it — `src/delivery`'s `Forge` port
 *   has no method that could move a ticket, which is how FR-060 is a shape rather than a rule.
 * - **The three-iteration bound is not here.** `MAX_ITERATIONS` is where the loop stops *asking*;
 *   the authority is the `iterations_ordinal_bounds` check constraint, because a run is
 *   snapshotted, restored and re-invoked and an in-memory count survives none of that (FR-061).
 */

export { runAutonomousWorkflow } from './autonomous'
export type {
  AutonomousIteration,
  AutonomousOutcome,
  AutonomousResult,
  AutonomousWorkflowInput,
} from './autonomous'

export { DEV_SKILL, DEVELOP_STEP, runDevelopStep } from './develop-step'
export type {
  DeveloperPort,
  DevelopmentProposal,
  DevelopmentRequest,
  DevelopStepInput,
  DevelopStepResult,
} from './develop-step'

export {
  EXHAUSTION_OUTCOME,
  exhaustionReport,
  fourthIterationRefused,
  mustStopForAttention,
} from './exhausted'
export type { ExhaustionReport } from './exhausted'

export {
  FORBIDDEN_IDENTIFIERS,
  FORBIDDEN_LITERALS,
  scanDirectory,
  scanSource,
  stripComments,
} from './hardcoded-convention-scan'
export type { ConventionViolation, ForbiddenConvention } from './hardcoded-convention-scan'

export {
  INTEGRATION_ACTION,
  INTEGRATION_SKILL,
  INTEGRATION_STEP,
  resolveIntegrationPlan,
  runIntegrationStep,
} from './integration-step'
export type {
  DeclaredIntegrationPlan,
  DeclaredIntegrationStep,
  IntegrationOutcome,
  IntegrationPlanner,
  IntegrationPort,
  IntegrationStepInput,
  IntegrationStepRef,
  IntegrationStepResult,
  ResolvedIntegrationPlan,
} from './integration-step'

export {
  hasPassed,
  isExhausted,
  iterationBoundError,
  MAX_ITERATIONS,
  nextOrdinal,
  recordIteration,
  unresolvedFindings,
} from './iteration-record'
export type {
  IterationFinding,
  IterationHistory,
  IterationRecord,
  IterationReporter,
  IterationVerdict,
} from './iteration-record'

export { runReviewWorkflow } from './review'
export type { ReviewWorkflowResult, RunReviewWorkflowInput } from './review'

export {
  createReviewGuard,
  DEAD_TARGET_STATES,
  isDeadTargetState,
  openTargetGuard,
  REVIEW_CHECKPOINTS,
} from './review-guard'
export type {
  NoOpReviewOutcome,
  ObservedTarget,
  ReviewCheckpoint,
  ReviewGuard,
  ReviewGuardDecision,
  ReviewTargetProbe,
  ReviewTargetState,
} from './review-guard'

export { applyReviewOutcome, REVIEW_COMMENT_ACTION } from './review-outcome'
export type {
  ApplyReviewOutcomeInput,
  FindingsPublisher,
  PostedFindings,
  ReviewCommentRef,
  ReviewOutcomeRecord,
} from './review-outcome'

export { reviewPullRequestSet, unknownEntryFindingError } from './review-set'
export type { ReviewSetAssessment, ReviewSetInput } from './review-set'

export { REVIEW_SKILL, REVIEW_STEP, runReviewStep } from './review-step'
export type {
  ReviewAssessment,
  ReviewerPort,
  ReviewProposal,
  ReviewRequest,
  ReviewStepInput,
  ReviewTarget,
} from './review-step'

export {
  directiveDigests,
  directiveFrom,
  requireDirective,
  undirectedActionError,
} from './skill-directive'
export type { SkillDirective } from './skill-directive'

export {
  TICKET_TRANSITION_ACTION,
  ticketTransitionKey,
  ticketUntouched,
  transitionTicket,
} from './ticket'
export type {
  TicketPort,
  TicketTransitionRecord,
  TicketTransitionRef,
  TicketUntouchedRecord,
  TransitionTicketInput,
} from './ticket'
