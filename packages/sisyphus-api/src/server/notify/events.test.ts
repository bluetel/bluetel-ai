import { describe, expect, it } from 'vitest'

import { NOTIFICATION_EVENTS, REVIEW_VERDICTS, TERMINAL_OUTCOMES } from '../../enums'

import { notificationEventForOutcome, notificationEventForVerdict } from './events'

/**
 * Which of this package's writes are notifiable (FR-136).
 *
 * The point of these assertions is not that a particular outcome maps to a particular string —
 * that is one line of the map. It is that the mapping is **total** and that the events it names
 * are real members of the closed vocabulary, so an outcome added without an event is caught here
 * rather than by a run that ends in silence.
 */
describe('notificationEventForOutcome', () => {
  it('names a real notification event for every terminal outcome', () => {
    for (const outcome of TERMINAL_OUTCOMES) {
      expect(NOTIFICATION_EVENTS).toContain(notificationEventForOutcome(outcome))
    }
  })

  it('follows the workflow_<outcome> naming the event vocabulary is built on', () => {
    // The same relationship `src/enums/notification-event.test.ts` asserts, restated against the
    // map: it is what lets this file and the control plane's `EVENT_BY_STATE` agree without either
    // importing the other.
    for (const outcome of TERMINAL_OUTCOMES) {
      expect(notificationEventForOutcome(outcome)).toBe(`workflow_${outcome}`)
    }
  })

  it('gives every outcome its own event, so two cannot collapse into one message', () => {
    const events = TERMINAL_OUTCOMES.map(notificationEventForOutcome)
    expect(new Set(events).size).toBe(TERMINAL_OUTCOMES.length)
  })

  it('covers the four events no control-plane job emits', () => {
    // These are exactly the ones `notifier.ts` records as belonging to this package's surface.
    expect(notificationEventForOutcome('succeeded')).toBe('workflow_succeeded')
    expect(notificationEventForOutcome('capped')).toBe('workflow_capped')
    expect(notificationEventForOutcome('cancelled')).toBe('workflow_cancelled')
    expect(notificationEventForOutcome('needs_attention')).toBe('workflow_needs_attention')
  })
})

describe('notificationEventForVerdict', () => {
  it('announces a failed review iteration (FR-136)', () => {
    expect(notificationEventForVerdict('fail')).toBe('review_iteration_failed')
  })

  it('says nothing about a passing one', () => {
    // A message per pass of a three-pass loop is the burst FR-139 exists to prevent.
    expect(notificationEventForVerdict('pass')).toBeUndefined()
  })

  it('answers for every verdict in the vocabulary', () => {
    for (const verdict of REVIEW_VERDICTS) {
      const event = notificationEventForVerdict(verdict)
      expect(event === undefined || NOTIFICATION_EVENTS.includes(event)).toBe(true)
    }
  })
})
