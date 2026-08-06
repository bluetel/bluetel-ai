import { createEnumGuard } from './enum-guard'

/**
 * What became of a supervision command (`pause`, `resume`, `stop`).
 *
 * `superseded` is why this is a separate vocabulary from the corrections outcome: a `pause`
 * overtaken by a `stop` before either is collected is superseded, not applied, so the executor
 * never runs a command the user has already replaced.
 */
export const SUPERVISION_DELIVERY_OUTCOMES = [
  'pending',
  'acknowledged',
  'superseded',
  'rejected',
] as const

export type SupervisionDeliveryOutcome = (typeof SUPERVISION_DELIVERY_OUTCOMES)[number]

export const isSupervisionDeliveryOutcome = createEnumGuard(SUPERVISION_DELIVERY_OUTCOMES)

/**
 * The subset an executor may report.
 *
 * `pending` is the row's state before anyone has said anything, so it is the *absence* of a report
 * and an executor claiming it would be claiming to have not answered. Stated as its own tuple
 * rather than filtered at the call site so the machine surface's `z.enum` keeps a literal type.
 */
export const REPORTABLE_SUPERVISION_DELIVERY_OUTCOMES = [
  'acknowledged',
  'superseded',
  'rejected',
] as const

export type ReportableSupervisionDeliveryOutcome =
  (typeof REPORTABLE_SUPERVISION_DELIVERY_OUTCOMES)[number]
