import type { RouterOutputs } from '@sisyphus-admin/trpc'

import { notificationEventCopy } from './notification-events'

/**
 * Turning one effective preference into the words a row shows (T158, FR-138).
 *
 * ## The whole point of this module is the third state
 *
 * A preference has two values — notifying or muted — and **three** states, because a value can be
 * the platform's default or the person's decision. `workflow.notificationPreferences` returns
 * `explicit: false` for an event with no stored row, and it does so precisely because absence means
 * *enabled*: a user who has never opened this screen is notified about their own runs
 * (`server/workflow/watch.ts`, `applyPreferenceDefaults`).
 *
 * A screen that rendered eight switches all reading "on" would be lying by omission — it would show
 * a settled configuration where there is in fact no configuration at all, and a person reading it
 * would reasonably conclude they had once chosen this. So every row says which of the two it is,
 * and the panel says how many of the set are still untouched. This is the module that makes that
 * sayable without rendering anything.
 *
 * ## Why the type comes from the router
 *
 * `RouterOutputs` rather than a hand-written mirror: a DTO that matches the procedure today drifts
 * silently the day the procedure changes, and nothing fails. If the API stops returning `explicit`,
 * this file must stop compiling — that flag is the only thing standing between this screen and the
 * lie above.
 */

/** One event and the caller's effective setting, exactly as the procedure returns it. */
export type NotificationPreference = RouterOutputs['workflow']['notificationPreferences'][number]

/** What a preference row renders. */
export interface PreferenceReadouts {
  /** The machine's name for the event. Used as a key and as an element id — never displayed. */
  readonly event: NotificationPreference['event']
  readonly label: string
  readonly detail: string
  readonly enabled: boolean
  /** False when this value is the platform's default rather than a recorded decision. */
  readonly explicit: boolean
  /** The chip's readout: what will happen, in the machine's voice. */
  readonly stateReadout: string
  /** Where the value came from — `your choice` or `default`. Rendered beside the state, always. */
  readonly origin: string
  /** The control's label, which names the change it makes rather than the state it is in. */
  readonly action: string
}

/** The chip readouts. Two values, and neither of them says anything about where it came from. */
const STATE_READOUTS = { on: 'notifying', off: 'muted' } as const

/** The origin markers. Present on **every** row: a marker only some rows carry is a badge. */
const ORIGIN_READOUTS = { chosen: 'your choice', default: 'default' } as const

/**
 * Describe one preference.
 *
 * @param preference - One entry from `workflow.notificationPreferences`.
 */
export const toPreferenceReadouts = (preference: NotificationPreference): PreferenceReadouts => {
  const copy = notificationEventCopy(preference.event)

  return {
    event: preference.event,
    label: copy.label,
    detail: copy.detail,
    enabled: preference.enabled,
    explicit: preference.explicit,
    stateReadout: preference.enabled ? STATE_READOUTS.on : STATE_READOUTS.off,
    origin: preference.explicit ? ORIGIN_READOUTS.chosen : ORIGIN_READOUTS.default,
    action: preference.enabled ? 'Mute this event' : 'Notify me about this',
  }
}

/** How many of the set the caller has actually decided, and what that means. */
export interface DefaultsSummary {
  /** Rows carrying a stored decision. */
  readonly chosen: number
  /** Rows still on the platform default. */
  readonly defaulted: number
  /** The card's chip readout — `defaults 8 of 8`, or `chosen 8 of 8` once none are left. */
  readonly readout: string
  /** What the numbers mean, in a sentence an operator can act on. */
  readonly detail: string
}

/**
 * Summarise how much of this screen is still the platform's opinion rather than the caller's.
 *
 * Said at the top of the card because it is the fact the rows cannot state between them: eight rows
 * each marked `default` is easy to skim past, and "you have chosen none of these" is not.
 *
 * @param preferences - Every event, as the procedure returned it.
 */
export const describeDefaults = (
  preferences: readonly NotificationPreference[],
): DefaultsSummary => {
  const total = preferences.length
  const chosen = preferences.filter((preference) => preference.explicit).length
  const defaulted = total - chosen

  return {
    chosen,
    defaulted,
    readout:
      defaulted === 0
        ? `chosen ${String(total)} of ${String(total)}`
        : `defaults ${String(defaulted)} of ${String(total)}`,
    detail:
      defaulted === 0
        ? 'Every event below carries a decision you made. Nothing here is a default.'
        : `${String(defaulted)} of these ${String(total)} events are still on the platform default, which is to notify you. That is not a choice you made — until you touch a row, it has no stored setting at all, and the default is what would change if the platform's changed.`,
  }
}
