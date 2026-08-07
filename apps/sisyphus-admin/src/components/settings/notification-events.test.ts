import { NOTIFICATION_EVENTS } from '@bluetel-ai/sisyphus-api/client'
import { describe, expect, it } from 'vitest'

import {
  NOTIFICATION_EVENT_COPY,
  NOTIFICATION_EVENT_ORDER,
  notificationEventCopy,
} from './notification-events'

describe('the notification event vocabulary', () => {
  it('names every event the platform can send, and no others', () => {
    expect(Object.keys(NOTIFICATION_EVENT_COPY).sort()).toStrictEqual(
      [...NOTIFICATION_EVENTS].sort(),
    )
  })

  it('lists the events in the platform’s own order', () => {
    expect(NOTIFICATION_EVENT_ORDER).toStrictEqual(NOTIFICATION_EVENTS)
  })

  it('never lets an enum value reach a screen as its identifier', () => {
    for (const event of NOTIFICATION_EVENTS) {
      const copy = notificationEventCopy(event)

      expect(copy.label).not.toContain('_')
      expect(copy.label).not.toBe(event)
    }
  })

  it('says when each event fires, in words the label does not already use', () => {
    for (const event of NOTIFICATION_EVENTS) {
      const copy = notificationEventCopy(event)

      expect(copy.detail.length).toBeGreaterThan(copy.label.length)
      expect(copy.detail).not.toBe(copy.label)
    }
  })

  it('gives each event a label of its own, so two rows cannot read identically', () => {
    const labels = NOTIFICATION_EVENTS.map((event) => notificationEventCopy(event).label)

    expect(new Set(labels).size).toBe(labels.length)
  })
})
