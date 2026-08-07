import { describe, expect, it } from 'vitest'

import { fakeAudienceMember } from './notification-store-fake'
import { selectRecipients, unnotifiableRecipients, wantsEvent } from './recipients'

/**
 * The two defaults, asserted where they are decided.
 *
 * Both fail **silently** when inverted — the software keeps running and simply stops telling
 * anyone — so each is tested from the absence side first: no preference row at all, and no Slack
 * identity at all. A suite that only tested the populated cases would pass against an
 * implementation that notified nobody.
 */

describe('wantsEvent (FR-138)', () => {
  it('treats no stored row as enabled, which is the default the schema models', () => {
    expect(wantsEvent(null)).toBe(true)
  })

  it('honours a recorded decision either way', () => {
    expect(wantsEvent(false)).toBe(false)
    expect(wantsEvent(true)).toBe(true)
  })
})

describe('selectRecipients', () => {
  it('notifies a user who has never opened their preferences (FR-138)', () => {
    const chosen = selectRecipients([
      fakeAudienceMember({ userId: 'owner', preferenceEnabled: null }),
    ])

    expect(chosen).toHaveLength(1)
    expect(chosen[0]?.notifiable).toBe(true)
  })

  it('drops a user who opted out of this event, and nobody else', () => {
    const chosen = selectRecipients([
      fakeAudienceMember({ userId: 'owner', preferenceEnabled: false }),
      fakeAudienceMember({ userId: 'watcher', relation: 'watcher', preferenceEnabled: null }),
    ])

    expect(chosen.map((person) => person.userId)).toStrictEqual(['watcher'])
  })

  it('keeps a user with no Slack identity, marked unnotifiable (FR-140)', () => {
    // Removing them would be the intuitive move and is wrong: FR-140 requires them to be recorded
    // and surfaced, which the panel cannot do if the delivery path never mentions them.
    const chosen = selectRecipients([
      fakeAudienceMember({ userId: 'owner', slackUserId: null }),
      fakeAudienceMember({ userId: 'blank', slackUserId: '', relation: 'watcher' }),
    ])

    expect(chosen).toHaveLength(2)
    expect(chosen.every((person) => !person.notifiable)).toBe(true)
    expect(unnotifiableRecipients(chosen).map((person) => person.userId)).toStrictEqual([
      'owner',
      'blank',
    ])
  })

  it('drops a deactivated user, whose access was withdrawn (FR-176)', () => {
    const chosen = selectRecipients([
      fakeAudienceMember({ userId: 'gone', isActive: false }),
      fakeAudienceMember({ userId: 'here' }),
    ])

    expect(chosen.map((person) => person.userId)).toStrictEqual(['here'])
  })

  it('sends one message to a person who both owns and watches the run (FR-139)', () => {
    const chosen = selectRecipients([
      fakeAudienceMember({ userId: 'both', relation: 'owner' }),
      fakeAudienceMember({ userId: 'both', relation: 'watcher' }),
    ])

    expect(chosen).toHaveLength(1)
    expect(chosen[0]?.relation).toBe('owner')
  })

  it('keeps the owner relation whichever order the rows arrive in', () => {
    const chosen = selectRecipients([
      fakeAudienceMember({ userId: 'both', relation: 'watcher' }),
      fakeAudienceMember({ userId: 'both', relation: 'owner' }),
    ])

    expect(chosen).toHaveLength(1)
    expect(chosen[0]?.relation).toBe('owner')
  })

  it('returns nothing for an empty audience without inventing a fallback recipient', () => {
    expect(selectRecipients([])).toStrictEqual([])
  })
})
