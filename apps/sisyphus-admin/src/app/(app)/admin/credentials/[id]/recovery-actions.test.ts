import { describe, expect, it } from 'vitest'

import type { CredentialDetail } from './recovery-actions'
import { FORCE_RELEASE_WARNING, recoveryAffordancesFor } from './recovery-actions'

/**
 * The recovery order (T121, FR-005, FR-006, FR-057, FR-072, SC-012).
 *
 * What is worth testing here is not which buttons appear — it is that the screen tells an
 * administrator the *sequence*, because the sequence is the non-obvious part of US9 and the reason
 * SC-012's five minutes is not automatic. Disabling a broken seat achieves nothing on its own while
 * a run is holding it; the run has to be displaced first, and only then can the seat be logged in
 * again. An administrator who has to discover that by pressing buttons will not do it in five
 * minutes.
 */

const seat = (overrides: Partial<CredentialDetail> = {}): CredentialDetail =>
  ({
    id: '0199a1f4-0000-7000-8000-000000000001',
    credentialGroupId: '0199a1f4-0000-7000-8000-000000000002',
    credentialGroupName: 'vendor-pool',
    credentialGroupEnabled: true,
    name: 'vendor-seat-3',
    state: 'available',
    secretId: 'sisyphus/agent-credential/vendor-seat-3',
    enabled: true,
    lastLoginAt: null,
    lastUsedAt: null,
    lastExercisedAt: null,
    coolingOffUntil: null,
    lastFailureReason: null,
    archivedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    selectable: true,
    ...overrides,
  }) as CredentialDetail

describe('recoveryAffordancesFor', () => {
  it('offers a healthy seat nothing to recover from', () => {
    const affordances = recoveryAffordancesFor(seat())

    expect(affordances.canDisable).toBe(true)
    expect(affordances.canEnable).toBe(false)
    expect(affordances.canForceRelease).toBe(false)
    expect(affordances.canLogIn).toBe(false)
    expect(affordances.nextStep).toBeUndefined()
  })

  it('offers re-login on a broken seat, and never withholds it (FR-010, FR-072)', () => {
    // The same two states the router admits a login from. Re-login is not a lesser path: it is the
    // identical procedure, offered here for exactly the reason a first login is.
    expect(recoveryAffordancesFor(seat({ state: 'unhealthy' })).canLogIn).toBe(true)
    expect(recoveryAffordancesFor(seat({ state: 'awaiting_login' })).canLogIn).toBe(true)
  })

  it('does not offer a login on a seat a run is holding, because the server refuses one', () => {
    // Replacing the material of an identity a run is authenticated as would invalidate the copy
    // that run is using. The panel declines to offer what the server declines to do.
    expect(recoveryAffordancesFor(seat({ state: 'held' })).canLogIn).toBe(false)
    expect(recoveryAffordancesFor(seat({ state: 'available' })).canLogIn).toBe(false)
  })

  it('offers force-release only when a run is actually holding the seat (FR-057)', () => {
    expect(recoveryAffordancesFor(seat({ state: 'held' })).canForceRelease).toBe(true)

    for (const state of ['available', 'unhealthy', 'cooling_off', 'awaiting_login'] as const) {
      expect(recoveryAffordancesFor(seat({ state })).canForceRelease).toBe(false)
    }
  })

  it('tells an administrator to disable a broken seat before anything else', () => {
    const affordances = recoveryAffordancesFor(seat({ state: 'unhealthy', enabled: true }))

    expect(affordances.nextStep).toContain('Disable it first')
    expect(affordances.nextStep).toContain('stops offering it')
  })

  /**
   * **The step that is not obvious, and the reason this module exists.** A seat can be disabled and
   * still held: FR-006 withholds from *future* selection and evicts nobody. An administrator who
   * stops here has taken the seat out of the pool and has not recovered it — it cannot be logged in
   * while a run holds it — and nothing on the screen would otherwise say so.
   */
  it('says that disabling a held seat has not freed it, and names the step that does', () => {
    const affordances = recoveryAffordancesFor(seat({ state: 'held', enabled: false }))

    expect(affordances.nextStep).toContain('interrupts nothing')
    expect(affordances.nextStep).toContain('Force-release')
    expect(affordances.nextStep).toContain('ends that run')
    expect(affordances.nextStep).toContain('log in again')
  })

  it('warns against forcing a held seat free before it has been disabled', () => {
    // Otherwise the pool can hand the seat to another run between the release and the login, and
    // the recovery starts again against a different workflow.
    expect(recoveryAffordancesFor(seat({ state: 'held', enabled: true })).nextStep).toContain(
      'Disable it before forcing it free',
    )
  })

  it('tells an administrator that a cooling-off seat needs nobody (FR-075, FR-076)', () => {
    const affordances = recoveryAffordancesFor(seat({ state: 'cooling_off' }))

    // A provider limit is not a breakage, raises no alert, and clears without human action.
    expect(affordances.nextStep).toContain('clears by itself')
    expect(affordances.canLogIn).toBe(false)
  })

  it('names the group when the group is what is withholding the seat (FR-066)', () => {
    const affordances = recoveryAffordancesFor(
      seat({ credentialGroupEnabled: false, selectable: false }),
    )

    expect(affordances.nextStep).toContain('vendor-pool')
    expect(affordances.nextStep).toContain('withholds every seat in it')
  })

  it('offers nothing on an archived seat and says why it cannot come back (FR-005)', () => {
    const affordances = recoveryAffordancesFor(seat({ archivedAt: new Date(), enabled: false }))

    expect(affordances.canDisable).toBe(false)
    expect(affordances.canEnable).toBe(false)
    expect(affordances.canForceRelease).toBe(false)
    expect(affordances.canLogIn).toBe(false)
    expect(affordances.canAttemptDelete).toBe(false)
    expect(affordances.nextStep).toContain('what identity they worked as')
  })

  /**
   * FR-005's refusal belongs to the server, where the lease count is. A panel that predicted it
   * would be a second implementation of the requirement, and the one an administrator sees would be
   * the one that is wrong.
   */
  it('always offers to attempt a delete on a live seat, and predicts nothing about the refusal', () => {
    for (const state of ['available', 'held', 'unhealthy', 'awaiting_login'] as const) {
      expect(recoveryAffordancesFor(seat({ state })).canAttemptDelete).toBe(true)
    }
  })
})

describe('the force-release warning', () => {
  it('says what it costs, which is a run rather than a seat (FR-023, FR-057)', () => {
    expect(FORCE_RELEASE_WARNING).toContain('ends the run currently holding it')
    expect(FORCE_RELEASE_WARNING).toContain('never moved to a different agent credential')
    expect(FORCE_RELEASE_WARNING).toContain('relaunch')
  })
})
