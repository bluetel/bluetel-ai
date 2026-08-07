import { describe, expect, it } from 'vitest'

import type { NotificationPreference } from './preference-readouts'
import { describeDefaults, toPreferenceReadouts } from './preference-readouts'

const preference = (overrides: Partial<NotificationPreference> = {}): NotificationPreference => ({
  event: 'workflow_succeeded',
  enabled: true,
  explicit: false,
  ...overrides,
})

describe('describing one preference', () => {
  it('names the event in prose rather than by its enum value', () => {
    const readouts = toPreferenceReadouts(preference({ event: 'workflow_parked_resumable' }))

    expect(readouts.label).toBe('Run parked, resumable')
    expect(readouts.detail).not.toContain('workflow_parked_resumable')
  })

  it('reports a default as a default, not as a setting the caller chose (FR-138)', () => {
    expect(toPreferenceReadouts(preference({ enabled: true, explicit: false }))).toMatchObject({
      stateReadout: 'notifying',
      origin: 'default',
    })
  })

  it('reports a stored decision as one, even when it agrees with the default', () => {
    // The interesting case: `enabled: true, explicit: true` and `enabled: true, explicit: false`
    // have the same effect today and are different facts. A screen that rendered them identically
    // would be unable to tell anyone which of their settings would move if the default did.
    const chosen = toPreferenceReadouts(preference({ enabled: true, explicit: true }))
    const defaulted = toPreferenceReadouts(preference({ enabled: true, explicit: false }))

    expect(chosen.stateReadout).toBe(defaulted.stateReadout)
    expect(chosen.origin).not.toBe(defaulted.origin)
    expect(chosen.origin).toBe('your choice')
  })

  it('marks the origin of every row, so the marker is information rather than a badge', () => {
    for (const explicit of [true, false]) {
      expect(toPreferenceReadouts(preference({ explicit })).origin).not.toBe('')
    }
  })

  it('labels the control with the change it makes, not the state it is in', () => {
    expect(toPreferenceReadouts(preference({ enabled: true })).action).toBe('Mute this event')
    expect(toPreferenceReadouts(preference({ enabled: false })).action).toBe('Notify me about this')
  })

  it('reads a muted event as muted', () => {
    expect(toPreferenceReadouts(preference({ enabled: false, explicit: true })).stateReadout).toBe(
      'muted',
    )
  })
})

describe('summarising how much of the screen is still the platform’s opinion', () => {
  const untouched = [
    preference({ event: 'workflow_succeeded' }),
    preference({ event: 'workflow_failed' }),
    preference({ event: 'workflow_capped' }),
  ]

  it('counts the rows carrying no stored decision', () => {
    expect(describeDefaults(untouched)).toMatchObject({ chosen: 0, defaulted: 3 })
  })

  it('says out loud that an untouched screen is not a configuration (FR-138)', () => {
    const summary = describeDefaults(untouched)

    expect(summary.readout).toBe('defaults 3 of 3')
    expect(summary.detail).toContain('not a choice you made')
  })

  it('stops claiming defaults once every row has been decided', () => {
    const decided = untouched.map((row) => ({ ...row, explicit: true }))

    expect(describeDefaults(decided)).toMatchObject({ chosen: 3, defaulted: 0 })
    expect(describeDefaults(decided).readout).toBe('chosen 3 of 3')
    expect(describeDefaults(decided).detail).toContain('Nothing here is a default')
  })

  it('counts a mixture honestly', () => {
    const mixed = [untouched[0], { ...untouched[1], explicit: true }] as NotificationPreference[]

    expect(describeDefaults(mixed)).toMatchObject({ chosen: 1, defaulted: 1 })
    expect(describeDefaults(mixed).readout).toBe('defaults 1 of 2')
  })
})
