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

export { extractProposal, PROPOSAL_TAG, proposalMarkers, stripCodeFence } from './proposal-block'
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
