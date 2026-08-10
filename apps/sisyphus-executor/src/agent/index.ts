export { AgentAdapterError } from './adapter'
export type {
  AgentAdapter,
  AgentAssistantFrame,
  AgentFailureKind,
  AgentFrame,
  AgentQuiesceOptions,
  AgentQuiescedState,
  AgentResultFrame,
  AgentSendTurnOptions,
  AgentStartOptions,
  AgentStopOptions,
  AgentStopResult,
  AgentSystemFrame,
  AgentTurnDelivery,
  AgentUnknownFrame,
  AgentUsage,
  AgentUserFrame,
} from './adapter'

export { createCliStreamAdapter, logUnknownFrame } from './cli-stream'
export type { CliStreamAdapterOptions } from './cli-stream'

export {
  developTurnBody,
  renderFeedback,
  renderFinding,
  renderReportInstruction,
} from './develop-turn'
export type { DevelopTurnOptions } from './develop-turn'

export {
  AgentProposalError,
  createAgentDeveloperPort,
  DEFAULT_PROPOSAL_DEADLINE_MS,
  DEFAULT_SETTLE_MS,
  DEFAULT_TURN_TIMEOUT_MS,
} from './developer-port'
export type { AgentDeveloperPortOptions, AgentProposalFailure } from './developer-port'

export { PROPOSAL_KEYS, readDevelopmentProposal, SUMMARY_LISTS } from './development-proposal'
export type { ProposalReading } from './development-proposal'

export {
  AgentIntegrationError,
  createAgentIntegrationPorts,
  DEFAULT_PLAN_DEADLINE_MS,
  DEFAULT_STEP_DEADLINE_MS,
} from './integration-ports'
export type {
  AgentIntegrationFailure,
  AgentIntegrationPorts,
  AgentIntegrationPortsOptions,
} from './integration-ports'

export { PLAN_KEYS, readIntegrationPlan } from './integration-plan'
export type { IntegrationPlanReading } from './integration-plan'

export {
  INTEGRATION_PLAN_TAG,
  INTEGRATION_STEP_TAG,
  integrationPlanTurnBody,
  integrationStepTurnBody,
  renderPlanReportInstruction,
  renderStepReportInstruction,
} from './integration-turn'
export type { IntegrationPlanTurnOptions, IntegrationStepTurnOptions } from './integration-turn'

export { readReviewProposal, REVIEW_KEYS } from './review-proposal'
export type { ReviewProposalReading } from './review-proposal'

export {
  DEFAULT_TARGETS_DEADLINE_MS,
  renderEntry,
  resolveReviewTargets,
  REVIEW_TARGET_STEP,
  REVIEW_TARGETS_TAG,
  reviewTargetError,
  reviewTargetsTurnBody,
} from './review-targets'
export type {
  PullRequestReader,
  ResolveReviewTargetsOptions,
  ReviewTargetEntry,
} from './review-targets'

export {
  REVIEW_TAG,
  renderReviewReportInstruction,
  renderTarget,
  renderTargets,
  reviewTurnBody,
} from './review-turn'
export type { ReviewTurnOptions } from './review-turn'

export {
  AgentReviewError,
  createAgentReviewerPort,
  DEFAULT_REVIEW_DEADLINE_MS,
} from './reviewer-port'
export type { AgentReviewerPortOptions, AgentReviewFailure } from './reviewer-port'

export { askAgentForBlock } from './structured-turn'
export type { AgentAnswerFailure, AgentBlockAnswer, StructuredTurnOptions } from './structured-turn'

export { createFrameTap, observeAgentFrames } from './frame-tap'
export type { FrameObserver, FrameTap } from './frame-tap'

export { createFrameStream } from './frame-stream'
export type {
  FramePredicate,
  FrameStream,
  FrameStreamOptions,
  FrameWaitOutcome,
} from './frame-stream'

export {
  createFrameDecoder,
  encodeUserTurn,
  MODELLED_FRAME_TYPES,
  parseFrameLine,
  readMessageText,
  readResultUsage,
} from './frames'
export type { FrameDecoder, ModelledFrameType } from './frames'

export { buildClaudeArgs, buildClaudeEnv, claudeProcessSpec, CLAUDE_COMMAND } from './invocation'
export type { AgentProcessSpec, AgentProcessSpecFactory } from './invocation'

export {
  answerMarkers,
  extractBlock,
  extractProposal,
  PROPOSAL_TAG,
  proposalMarkers,
  stripCodeFence,
} from './proposal-block'
export type { ProposalExtraction, ProposalMarkers } from './proposal-block'

export { resolveTsxBinary, runStdinInjectionSpike, stubAgentEntry } from './spike-stdin'
export type {
  ObservedFrame,
  StdinInjectionOutcome,
  StdinInjectionSpikeOptions,
} from './spike-stdin'

export {
  GUIDED_MARKER,
  INJECTION_MARKER,
  parseStubAgentConfig,
  readAssistantText,
  readFrameText,
  readUserTurnText,
  runStubAgent,
  STUB_AGENT_DEFAULTS,
  userTurnFrame,
} from './stub-agent'
export type { StubAgentConfig, StubAgentStreams } from './stub-agent'
