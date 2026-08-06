import { createEnumGuard } from './enum-guard'

/**
 * The closed set of things a user can be notified about (FR-136).
 *
 * Also the closed set a preference row may reference, which is the reason it is closed at all: a
 * preference cannot silence an event that will never fire, and an event with no preference to
 * silence it cannot be quietly introduced.
 *
 * Every terminal outcome has a `workflow_<outcome>` member here — asserted rather than assumed by
 * the colocated test, because an outcome added without its event is a run that ends in silence.
 */
export const NOTIFICATION_EVENTS = [
  'workflow_succeeded',
  'workflow_failed',
  'workflow_capped',
  'workflow_cancelled',
  'workflow_needs_attention',
  'workflow_parked_resumable',
  'review_iteration_failed',
  'integration_tick_summary',
] as const

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number]

export const isNotificationEvent = createEnumGuard(NOTIFICATION_EVENTS)
