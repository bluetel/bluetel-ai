import { describe, expect, it } from 'vitest'

import { CREDENTIAL_RELEASE_REASONS, isCredentialReleaseReason } from './credential-release-reason'

describe('CREDENTIAL_RELEASE_REASONS', () => {
  it('names the three ways a lease stops being live, in order', () => {
    expect([...CREDENTIAL_RELEASE_REASONS]).toStrictEqual(['terminal', 'forced', 'login_replaced'])
  })

  it('holds no duplicates', () => {
    expect(new Set(CREDENTIAL_RELEASE_REASONS).size).toBe(CREDENTIAL_RELEASE_REASONS.length)
  })

  it('records the ordinary release as its own reason rather than as the absence of one', () => {
    // FR-019 makes `terminal` the only release that happens without a human, and a released lease
    // is otherwise indistinguishable from any other: all three leave `released_at` set and the
    // credential held by nobody. Inferring "no reason means routine" would make an unrecorded
    // forced release read as an ordinary hand back in the FR-058 audit trail.
    expect(CREDENTIAL_RELEASE_REASONS).toContain('terminal')
  })

  it('distinguishes a seat taken back from a credential re-logged-in underneath its holder', () => {
    // `forced` is an administrator (or the FR-022 sweep) ending a lease that was otherwise fine;
    // `login_replaced` is the credential's material changing under a lease nothing was wrong with
    // (FR-010, FR-072). One value for both would report a re-login as a seizure.
    expect(CREDENTIAL_RELEASE_REASONS).toContain('forced')
    expect(CREDENTIAL_RELEASE_REASONS).toContain('login_replaced')
  })

  it('guards membership', () => {
    expect(isCredentialReleaseReason('forced')).toBe(true)
    expect(isCredentialReleaseReason('login_replaced')).toBe(true)
    expect(isCredentialReleaseReason('paused')).toBe(false)
    expect(isCredentialReleaseReason('expired')).toBe(false)
  })
})
