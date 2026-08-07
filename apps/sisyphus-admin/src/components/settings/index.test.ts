import { describe, expect, it } from 'vitest'

import * as settings from './index'

describe('the settings barrel', () => {
  it('publishes the screen’s two cards and the shaping their tests reach for', () => {
    expect(Object.keys(settings).sort()).toStrictEqual([
      'NOTIFICATION_EVENT_COPY',
      'NOTIFICATION_EVENT_ORDER',
      'NotificationPreferenceRow',
      'NotificationPreferencesPanel',
      'SlackIdentityReadout',
      'describeDefaults',
      'notificationEventCopy',
      'toPreferenceReadouts',
    ])
  })

  it('exposes no second class-merge helper and no local primitive', () => {
    expect(Object.keys(settings)).not.toContain('cn')
    expect(Object.keys(settings)).not.toContain('Button')
    expect(Object.keys(settings)).not.toContain('StateChip')
  })
})
