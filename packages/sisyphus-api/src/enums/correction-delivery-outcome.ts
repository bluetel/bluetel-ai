import { createEnumGuard } from './enum-guard'

/**
 * What became of a correction handed to a running agent.
 *
 * A correction that cannot be delivered fails **visibly** rather than being dropped (FR-049,
 * FR-081) — which is the whole reason this is recorded per correction instead of being inferred
 * from whether the run's behaviour changed.
 *
 * Deliberately without `superseded`: corrections queue and all of them are delivered, whereas a
 * supervision command can be replaced before collection. See
 * {@link SUPERVISION_DELIVERY_OUTCOMES}.
 */
export const CORRECTION_DELIVERY_OUTCOMES = ['pending', 'delivered', 'failed', 'rejected'] as const

export type CorrectionDeliveryOutcome = (typeof CORRECTION_DELIVERY_OUTCOMES)[number]

export const isCorrectionDeliveryOutcome = createEnumGuard(CORRECTION_DELIVERY_OUTCOMES)

/**
 * The subset an executor may report.
 *
 * `pending` is the row's state before the executor has said anything, so it is not something the
 * executor can report about itself.
 */
export const REPORTABLE_CORRECTION_DELIVERY_OUTCOMES = ['delivered', 'failed', 'rejected'] as const

export type ReportableCorrectionDeliveryOutcome =
  (typeof REPORTABLE_CORRECTION_DELIVERY_OUTCOMES)[number]
