import { describe, expect, it } from 'vitest'

import { CREDENTIAL_STATES, isCredentialState } from './credential-state'

describe('CREDENTIAL_STATES', () => {
  it('matches the data-model state machine, in order', () => {
    expect([...CREDENTIAL_STATES]).toStrictEqual([
      'awaiting_login',
      'available',
      'held',
      'cooling_off',
      'unhealthy',
      'disabled',
    ])
  })

  it('holds no duplicates', () => {
    expect(new Set(CREDENTIAL_STATES).size).toBe(CREDENTIAL_STATES.length)
  })

  it('offers exactly one selectable state, so unselectable is the default for anything added', () => {
    // Selection filters on `state = 'available'` and nothing else (FR-034). Asserted as a count
    // rather than as `toContain('available')` because the failure this guards is a *seventh* member
    // arriving that somebody also treats as issuable — the set's failure mode is one agent identity
    // reaching two runs at once, so a new value must be unselectable until this line is revisited.
    expect(CREDENTIAL_STATES.filter((state) => state === 'available')).toHaveLength(1)
    expect(CREDENTIAL_STATES).toHaveLength(6)
  })

  it('keeps every reason a credential is passed over distinguishable (FR-029)', () => {
    // The queue must report *which* scarcity is biting, so these are five distinct states rather
    // than one `unavailable`. Collapsing any pair would still leave selection correct and would
    // still leave the queue unable to say why it is waiting.
    const unselectable = CREDENTIAL_STATES.filter((state) => state !== 'available')
    expect([...unselectable]).toStrictEqual([
      'awaiting_login',
      'held',
      'cooling_off',
      'unhealthy',
      'disabled',
    ])
  })

  it('keeps a credential with no proven login out of service as a state, not as a check (FR-008)', () => {
    expect(CREDENTIAL_STATES).toContain('awaiting_login')
    expect(CREDENTIAL_STATES.indexOf('awaiting_login')).toBeLessThan(
      CREDENTIAL_STATES.indexOf('available'),
    )
  })

  it('separates the self-clearing limit from the breakage that needs a human (research R5)', () => {
    // `cooling_off` returns to the pool by itself (FR-076, FR-078) and raises nothing; `unhealthy`
    // alerts and waits on somebody. One value for both would force the ambiguous provider response
    // to choose between alerting on every rate limit and never alerting on a broken login.
    expect(CREDENTIAL_STATES).toContain('cooling_off')
    expect(CREDENTIAL_STATES).toContain('unhealthy')
  })

  it('guards membership', () => {
    expect(isCredentialState('available')).toBe(true)
    expect(isCredentialState('cooling_off')).toBe(true)
    expect(isCredentialState('leased')).toBe(false)
    expect(isCredentialState('cooling-off')).toBe(false)
  })
})
