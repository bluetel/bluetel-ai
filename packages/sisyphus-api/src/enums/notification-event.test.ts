import { describe, expect, it } from 'vitest'

import { isNotificationEvent, NOTIFICATION_EVENTS } from './notification-event'
import { TERMINAL_OUTCOMES } from './terminal-outcome'

describe('NOTIFICATION_EVENTS', () => {
  it('covers every terminal outcome, so no run can end in silence (FR-136)', () => {
    for (const outcome of TERMINAL_OUTCOMES) {
      expect(NOTIFICATION_EVENTS).toContain(`workflow_${outcome}`)
    }
  })

  it('also carries the two events that are not run outcomes', () => {
    expect(NOTIFICATION_EVENTS).toContain('review_iteration_failed')
    expect(NOTIFICATION_EVENTS).toContain('integration_tick_summary')
  })

  it('holds nothing beyond the outcomes and those two', () => {
    expect(NOTIFICATION_EVENTS.length).toBe(TERMINAL_OUTCOMES.length + 2)
  })

  it('guards membership — a preference cannot silence an event that will never fire', () => {
    expect(isNotificationEvent('workflow_succeeded')).toBe(true)
    expect(isNotificationEvent('workflow_daydreamed')).toBe(false)
  })
})
