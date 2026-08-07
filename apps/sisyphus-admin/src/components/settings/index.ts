/**
 * The account settings surface (T157..T159, US11, FR-138, FR-140).
 *
 * Two things live here and they are deliberately separate cards on one screen: **where** a
 * notification would be delivered, and **which** notifications the caller wants. The first can be
 * missing entirely — an unnotifiable account is a normal state, not an error — and a screen that
 * offered the second without the first would let someone configure messages that can never arrive.
 *
 * Watching a run is *not* here. It is a control on the workflow detail view, because the thing
 * being decided is about one run rather than about the account (FR-138 as amended).
 *
 * Consumers import this barrel, never a module inside it.
 */

export {
  NOTIFICATION_EVENT_COPY,
  NOTIFICATION_EVENT_ORDER,
  notificationEventCopy,
} from './notification-events'
export type { NotificationEventCopy } from './notification-events'

export { NotificationPreferenceRow } from './notification-preference-row'
export { NotificationPreferencesPanel } from './notification-preferences-panel'

export { describeDefaults, toPreferenceReadouts } from './preference-readouts'
export type {
  DefaultsSummary,
  NotificationPreference,
  PreferenceReadouts,
} from './preference-readouts'

export { SlackIdentityReadout } from './slack-identity-readout'
