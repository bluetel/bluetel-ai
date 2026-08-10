import { describe, expect, it } from 'vitest'

import * as barrel from './index'

/**
 * The barrel is the directory's public surface, and here the absences carry as much as the
 * presences.
 *
 * Two of them in particular. There is **no second classifier** — no `isRateLimit`, no
 * `looksUnhealthy` — because a caller able to ask half the question is a caller able to answer it
 * differently from `classifyProviderResponse`, and the whole argument of research R5 is that the
 * choice between `cooling_off` and `unhealthy` is made in exactly one place. And there is **no way
 * to set a credential's state directly**: every transition goes through a function that writes the
 * `state_changed` entry FR-058 requires, so a state change with no trail is not something a caller
 * can express.
 */

describe('the health barrel', () => {
  it('exports exactly three runtime values', () => {
    // Types erase, so this is the whole runtime surface. An equality rather than a `toContain`, so
    // that adding something here is a deliberate edit to this test.
    expect(Object.keys(barrel).sort()).toStrictEqual([
      'VERDICT_SOURCE_STATES',
      'applyHealthVerdict',
      'classifyProviderResponse',
      'returnFromCoolingOff',
    ])
  })

  it('exports one classifier, and it takes a response rather than a credential', () => {
    // The response is the evidence; the credential is not. A classifier that took an id would be
    // one that could reach the database, and it would stop being testable against a recording.
    expect(typeof barrel.classifyProviderResponse).toBe('function')
    expect(barrel.classifyProviderResponse.length).toBeLessThanOrEqual(2)
  })

  it('classifies without touching anything, so a verdict is not a write', () => {
    const verdict = barrel.classifyProviderResponse({ status: 429 })

    expect(verdict.state).toBe('cooling_off')
  })

  it('offers both directions of the cooling-off transition', () => {
    // Out on a limit and back when it clears (FR-076). The return is exported beside the departure
    // rather than living in the sweep, so both write the same shape of audit entry.
    expect(typeof barrel.applyHealthVerdict).toBe('function')
    expect(typeof barrel.returnFromCoolingOff).toBe('function')
  })

  it('names the states a verdict may be applied from, and excludes the three it may not', () => {
    expect([...barrel.VERDICT_SOURCE_STATES]).toStrictEqual(['available', 'held', 'cooling_off'])

    // `disabled` is an administrator's decision, `unhealthy` needs a person rather than a retry,
    // and `awaiting_login` has no material to have been refused.
    for (const excluded of ['disabled', 'unhealthy', 'awaiting_login']) {
      expect([...barrel.VERDICT_SOURCE_STATES]).not.toContain(excluded)
    }
  })

  it('offers no way to set a state without recording the change (FR-058)', () => {
    for (const name of Object.keys(barrel)) {
      expect(name).not.toMatch(/^setState|^markC|^updateState|^forceState/)
    }
  })

  it('offers no second opinion on what a response means (research R5)', () => {
    for (const name of Object.keys(barrel)) {
      expect(name).not.toMatch(/^isRateLimit|^isUnhealthy|^looksBroken|^shouldCoolOff/)
    }
  })

  it('exposes no way to reach a provider from here', () => {
    // Classification is offline by construction. The provider interaction lives behind the seam in
    // `../liveness/exercise.ts`, and a call from this directory would be a second one.
    for (const name of Object.keys(barrel)) {
      expect(name).not.toMatch(/exercise|probe|ping|call/i)
    }
  })
})
