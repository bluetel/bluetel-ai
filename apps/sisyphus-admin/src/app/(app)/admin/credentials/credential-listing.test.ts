import { describe, expect, it } from 'vitest'

import type { CredentialListItem } from './credential-listing'
import { toCredentialReadout } from './credential-listing'

/**
 * The shaping the pool view rests on (T034, FR-009).
 *
 * The assertions that matter are about **why a seat is not usable**. `selectable` is the server's
 * verdict and is never recomputed here — but a bare "no" is not actionable, and the sentence that
 * goes with it is what turns the pool view into something an administrator can work from. Each case
 * below is a different fix in a different place, which is why they are different sentences.
 */

const listed = (overrides: Partial<CredentialListItem> = {}): CredentialListItem => ({
  id: '0199a1f4-0000-7000-8000-000000000001',
  credentialGroupId: '0199a1f4-0000-7000-8000-000000000002',
  credentialGroupName: 'seats-a',
  credentialGroupEnabled: true,
  name: 'seat-one',
  state: 'available',
  secretId: 'arn:aws:secretsmanager:eu-west-2:000000000000:secret:seat-one',
  enabled: true,
  lastLoginAt: new Date('2026-08-05T09:14:22.031Z'),
  lastUsedAt: null,
  lastExercisedAt: null,
  coolingOffUntil: null,
  lastFailureReason: null,
  archivedAt: null,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  selectable: true,
  ...overrides,
})

describe('toCredentialReadout', () => {
  it('reports a usable seat with no explanation attached', () => {
    const readout = toCredentialReadout(listed())

    expect(readout.selectable).toBe(true)
    expect(readout.withheldBecause).toBeUndefined()
  })

  it('renders timestamps as machine readouts, and “never” where there is none', () => {
    const readout = toCredentialReadout(listed())

    expect(readout.lastLogin).toBe('2026-08-05 09:14')
    expect(readout.lastUsed).toBe('never')
  })

  it('says a seat awaiting a login has nothing for a run to fetch (FR-008)', () => {
    const readout = toCredentialReadout(
      listed({ state: 'awaiting_login', secretId: null, lastLoginAt: null, selectable: false }),
    )

    expect(readout.secretId).toBeUndefined()
    expect(readout.withheldBecause).toContain('no login has been completed')
  })

  it('names the group when the group is what was withdrawn (FR-006 group-wide)', () => {
    // The fix is on the group's screen, not this one, so the sentence has to say which group —
    // otherwise an administrator disables an already-usable seat looking for the problem.
    const readout = toCredentialReadout(
      listed({ credentialGroupEnabled: false, selectable: false }),
    )

    expect(readout.withheldBecause).toContain('its group seats-a is disabled')
  })

  it('says a disabled seat is withheld without interrupting anything (FR-006)', () => {
    const readout = toCredentialReadout(listed({ enabled: false, selectable: false }))

    expect(readout.withheldBecause).toContain('disabled')
    expect(readout.withheldBecause).toContain('without interrupting any run holding it')
  })

  it('explains a deleted seat as history rather than as a mistake (FR-005)', () => {
    const readout = toCredentialReadout(
      listed({
        archivedAt: new Date('2026-08-06T00:00:00.000Z'),
        enabled: false,
        selectable: false,
      }),
    )

    expect(readout.archived).toBe(true)
    expect(readout.withheldBecause).toContain('what identity they worked as')
  })

  it('prefers the deletion over every other reason, because nothing else can be acted on first', () => {
    const readout = toCredentialReadout(
      listed({
        archivedAt: new Date('2026-08-06T00:00:00.000Z'),
        credentialGroupEnabled: false,
        enabled: false,
        secretId: null,
        selectable: false,
      }),
    )

    expect(readout.withheldBecause).toContain('deleted')
  })

  it('says a held seat is held rather than broken', () => {
    const readout = toCredentialReadout(listed({ state: 'held', selectable: false }))

    expect(readout.withheldBecause).toBe('a run is holding it')
  })

  it('falls through to the state itself for cooling off and unhealthy', () => {
    expect(
      toCredentialReadout(listed({ state: 'cooling_off', selectable: false })).withheldBecause,
    ).toBe('it is cooling_off')
  })

  it('carries the provider’s own words about a failure, verbatim (FR-009)', () => {
    // The reason is very often the only evidence an administrator has. Rewording it here would put
    // the panel between them and it.
    const reason = 'the provider rejected the session: credentials expired 2026-08-04'
    const readout = toCredentialReadout(
      listed({ state: 'unhealthy', lastFailureReason: reason, selectable: false }),
    )

    expect(readout.lastFailureReason).toBe(reason)
  })
})
