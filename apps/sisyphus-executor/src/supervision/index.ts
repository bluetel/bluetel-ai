/**
 * Supervision — how a pause, a stop and a correction reach a running instance (Phase 7).
 *
 * Both queues share one discipline: the executor polls, applies in `sequence` order, and
 * acknowledges. Nothing is pushed, because a run on a reclaimable instance cannot be relied on to be
 * listening and an instance that accepts inbound connections is an instance with an ingress path
 * (FR-035).
 *
 * Consumers import this barrel, never a module underneath it.
 */

export {
  ACKNOWLEDGE_BUDGET_MS,
  PAUSE_LATENCY_CEILING_MS,
  pauseLatencyBudget,
  POLL_INTERVAL_MS,
  PULL_ROUND_TRIP_MS,
  QUIESCE_BUDGET_MS,
  SNAPSHOT_BUDGET_MS,
  SNAPSHOT_CAPTURE_BUDGET_MS,
  SNAPSHOT_REGISTER_BUDGET_MS,
  SNAPSHOT_RETRY_BUDGET_MS,
} from './budget'
export type { LatencyTerm, PauseLatencyBudget } from './budget'

export { DeadlineExceededError, isDeadlineExceeded, withDeadline } from './deadline'
export type { DeadlineOptions } from './deadline'

export {
  createCorrectionDeliverer,
  inSequenceOrder as correctionsInSequenceOrder,
  UNCONFIRMED_DELIVERY_REASON,
} from './corrections'
export type {
  CollectedCorrection,
  CorrectionAcknowledgement,
  CorrectionCycleResult,
  CorrectionDeliverer,
  CorrectionDelivererOptions,
  CorrectionDeliveryOutcome,
  CorrectionSender,
  CorrectionTransport,
  DeliveredCorrection,
} from './corrections'

export { createSupervisionPoller, inSequenceOrder } from './poll'
export type {
  AppliedCommand,
  CollectedCommand,
  CommandAcknowledgement,
  PollCycleResult,
  SupervisionAcknowledgementOutcome,
  SupervisionCommandName,
  SupervisionHandlers,
  SupervisionPoller,
  SupervisionPollerOptions,
  SupervisionTransport,
} from './poll'
