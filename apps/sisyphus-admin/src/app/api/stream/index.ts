/**
 * The live-log transport and its SSE envelope (T065, FR-046, SC-002, R6).
 *
 * Two kinds of module live here and the split matters.
 *
 * **Production.** `log-segment-event` (the wire shape, the SSE frame and the sequence reconciler),
 * `stream-access` (who may open a stream, and what everyone else is told), `resume-point`,
 * `log-segment-poll` (the transport spike S3 chose) and `segment-text` (reading one stored segment
 * back). The route modules under `[workflowId]/` wire these together and are reached by their path,
 * never through this barrel.
 *
 * **Evidence.** `spike-log-stream`, `spike-fixture` and `latency-stats` are the S3 measurement
 * harness. They stay exported so `SPIKE-FINDINGS.md` remains reproducible; nothing in the
 * production path imports them, and the fixture is reused only by the route's live-database test.
 *
 * Consumers import this barrel, never a module inside it.
 */

export type { LatencySummary } from './latency-stats'
export {
  formatLatencySummary,
  percentile,
  summariseLatencies,
  VISIBILITY_BUDGET_MS,
} from './latency-stats'

export type { LogSegmentEvent, SequenceDecision, SequenceReconciler } from './log-segment-event'
export {
  createSequenceReconciler,
  decodeNotifyPayload,
  encodeNotifyPayload,
  formatSseFrame,
  LOG_SEGMENT_CHANNEL,
  LOG_SEGMENT_SSE_EVENT,
} from './log-segment-event'

export type { LogSegmentPollOptions, LogStreamMessage } from './log-segment-poll'
export {
  DEFAULT_SEGMENT_BATCH,
  DEFAULT_STATE_INTERVAL_MS,
  isTerminalWorkflowState,
  LOG_POLL_INTERVAL_MS,
  pollLogSegments,
} from './log-segment-poll'

export { FROM_SEQUENCE_PARAMETER, LAST_EVENT_ID_HEADER, resolveResumePoint } from './resume-point'

export type { ReadSegmentTextOptions, SegmentTextResult } from './segment-text'
export { MAX_SEGMENT_BYTES, readSegmentText, segmentTextResponse } from './segment-text'

export type { StreamCloseReason } from './sse'
export {
  formatSseComment,
  formatSseRetry,
  formatStreamClosed,
  LOG_STREAM_CLOSED_EVENT,
  SSE_HEADERS,
  SSE_KEEPALIVE_MS,
  SSE_RETRY_MS,
} from './sse'

export type {
  LogStreamAccess,
  LogStreamAccessOptions,
  RevalidatingScopeOptions,
  StreamWorkflow,
} from './stream-access'
export {
  createRevalidatingScope,
  decideLogStreamAccess,
  identityFor,
  refusalResponse,
  SCOPE_REVALIDATION_MS,
} from './stream-access'

export type { SpikeFixtureIdentifiers } from './spike-fixture'
export {
  buildFixtureIdentifiers,
  createSpikeWorkflow,
  seedSpikeFixture,
  SPIKE_TAG_PREFIX,
  teardownSpikeFixture,
} from './spike-fixture'

export type {
  ScenarioOptions,
  ScenarioResult,
  SegmentSubscription,
  SegmentSubscriptionOptions,
  TransportName,
} from './spike-log-stream'
export {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_SETTLE_MS,
  mapSegmentRow,
  openSegmentSubscription,
  publishSegment,
  runTransportScenario,
} from './spike-log-stream'
