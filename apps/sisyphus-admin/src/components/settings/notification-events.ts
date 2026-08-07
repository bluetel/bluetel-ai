import type { NotificationEvent } from '@bluetel-ai/sisyphus-api/client'
import { NOTIFICATION_EVENTS } from '@bluetel-ai/sisyphus-api/client'

/**
 * What each notification event is called on the settings screen (T158, FR-138).
 *
 * The vocabulary itself is the platform's — {@link NOTIFICATION_EVENTS} — and is imported rather
 * than restated, so an event the platform grows appears here as a **type error** rather than as a
 * row silently missing from a screen whose whole job is to enumerate the set. That is the one
 * failure this module exists to prevent: a preferences screen that lists seven of eight events
 * looks like working software, and the eighth is simply unmanageable forever.
 *
 * The prose is here and not in the panel because it is the part a person reads and argues about,
 * and because a label is worth asserting without rendering anything: `workflow_parked_resumable`
 * must never reach a screen as `workflow_parked_resumable`.
 */

/** How one event is introduced: what it is called, and when it fires. */
export interface NotificationEventCopy {
  /** Sentence case, because it is prose rather than a machine readout. */
  readonly label: string
  /** When this fires, in one sentence. Never a restatement of the label. */
  readonly detail: string
}

/**
 * Every event, named.
 *
 * `Record<NotificationEvent, …>` rather than a partial map: adding an event to the platform
 * vocabulary without naming it here does not compile.
 */
export const NOTIFICATION_EVENT_COPY: Readonly<Record<NotificationEvent, NotificationEventCopy>> = {
  workflow_succeeded: {
    label: 'Run succeeded',
    detail: 'A run you own or watch finished with the work landed.',
  },
  workflow_failed: {
    label: 'Run failed',
    detail: 'A run stopped at a failure it could not get past.',
  },
  workflow_capped: {
    label: 'Run reached a cap',
    detail:
      'A run stopped because it reached its spend or iteration ceiling rather than an answer.',
  },
  workflow_cancelled: {
    label: 'Run cancelled',
    detail: 'A run was stopped by a person before it reached an outcome.',
  },
  workflow_needs_attention: {
    label: 'Run needs attention',
    detail: 'A run is waiting on a human decision and will not progress until it gets one.',
  },
  workflow_parked_resumable: {
    label: 'Run parked, resumable',
    detail: 'A run was set down in a state it can be picked up from later.',
  },
  review_iteration_failed: {
    label: 'Review iteration failed',
    detail: 'A review pass inside an autonomous run rejected the work and sent it round again.',
  },
  integration_tick_summary: {
    label: 'Integration tick summary',
    detail:
      'One digest for the runs an integration started on its last sweep, rather than one message each.',
  },
}

/**
 * The copy for one event.
 *
 * A function rather than an index expression at the call site, so a component reads
 * `notificationEventCopy(event).label` and cannot accidentally hold a `NotificationEventCopy |
 * undefined` that renders as an empty row.
 *
 * @param event - One of the platform's notification events.
 */
export const notificationEventCopy = (event: NotificationEvent): NotificationEventCopy =>
  NOTIFICATION_EVENT_COPY[event]

/**
 * The events, in the order the screen lists them — the platform's own order.
 *
 * Re-exported through this module rather than imported from the API package at each call site so
 * the screen has one source for both the set and its naming.
 */
export const NOTIFICATION_EVENT_ORDER: readonly NotificationEvent[] = NOTIFICATION_EVENTS
