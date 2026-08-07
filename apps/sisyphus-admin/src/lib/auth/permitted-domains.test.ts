import { describe, expect, it } from 'vitest'

import {
  describeDomainRejection,
  normalisePermittedDomain,
  toPermittedDomainSet,
  verifyPermittedDomain,
} from './permitted-domains'

const PERMITTED = ['bluetel.co.uk', 'example.com']

const workspaceClaims = (overrides: Record<string, unknown> = {}) => ({
  email: 'alice@bluetel.co.uk',
  email_verified: true,
  hd: 'bluetel.co.uk',
  ...overrides,
})

describe('verifyPermittedDomain', () => {
  it('admits a verified Workspace account whose hd claim is on the allowlist', () => {
    expect(verifyPermittedDomain(workspaceClaims(), PERMITTED)).toStrictEqual({
      permitted: true,
      domain: 'bluetel.co.uk',
    })
  })

  it('refuses a personal Google account, which carries no hd claim at all', () => {
    expect(verifyPermittedDomain(workspaceClaims({ hd: undefined }), PERMITTED)).toStrictEqual({
      permitted: false,
      reason: 'missing-hd-claim',
    })
  })

  it('refuses a Workspace account from a domain we do not permit', () => {
    expect(verifyPermittedDomain(workspaceClaims({ hd: 'attacker.net' }), PERMITTED)).toStrictEqual(
      { permitted: false, reason: 'domain-not-permitted' },
    )
  })

  it('refuses an unverified address even when the hd claim is right', () => {
    expect(
      verifyPermittedDomain(workspaceClaims({ email_verified: false }), PERMITTED),
    ).toStrictEqual({ permitted: false, reason: 'email-not-verified' })
  })

  it('refuses a missing email_verified claim rather than treating absence as verified', () => {
    expect(
      verifyPermittedDomain(workspaceClaims({ email_verified: undefined }), PERMITTED),
    ).toStrictEqual({ permitted: false, reason: 'email-not-verified' })
  })

  it('refuses the string "true" — a claim that is not the boolean is not a verification', () => {
    expect(
      verifyPermittedDomain(workspaceClaims({ email_verified: 'true' }), PERMITTED),
    ).toStrictEqual({ permitted: false, reason: 'email-not-verified' })
  })

  it('never falls back to the email suffix when hd is absent', () => {
    // The address says bluetel.co.uk and the allowlist contains it; only the missing hd claim
    // stands between this account and a session. That is the control.
    const verdict = verifyPermittedDomain(
      { email: 'alice@bluetel.co.uk', email_verified: true },
      PERMITTED,
    )
    expect(verdict).toStrictEqual({ permitted: false, reason: 'missing-hd-claim' })
  })

  it('matches the whole domain label, not a suffix of it', () => {
    expect(
      verifyPermittedDomain(workspaceClaims({ hd: 'not-example.com' }), PERMITTED),
    ).toStrictEqual({ permitted: false, reason: 'domain-not-permitted' })
    expect(
      verifyPermittedDomain(workspaceClaims({ hd: 'example.com.attacker.net' }), PERMITTED),
    ).toStrictEqual({ permitted: false, reason: 'domain-not-permitted' })
    expect(
      verifyPermittedDomain(workspaceClaims({ hd: 'sub.example.com' }), PERMITTED),
    ).toStrictEqual({ permitted: false, reason: 'domain-not-permitted' })
  })

  it('compares case-insensitively and ignores surrounding whitespace', () => {
    expect(
      verifyPermittedDomain(workspaceClaims({ hd: '  Example.COM ' }), PERMITTED),
    ).toStrictEqual({ permitted: true, domain: 'example.com' })
  })

  it('rejects a non-string hd claim rather than coercing it', () => {
    for (const hd of [42, true, null, { domain: 'example.com' }, ['example.com']]) {
      expect(verifyPermittedDomain(workspaceClaims({ hd }), PERMITTED)).toStrictEqual({
        permitted: false,
        reason: 'missing-hd-claim',
      })
    }
  })

  it('refuses everything when the allowlist is empty', () => {
    expect(verifyPermittedDomain(workspaceClaims(), [])).toStrictEqual({
      permitted: false,
      reason: 'domain-not-permitted',
    })
  })
})

describe('normalisePermittedDomain', () => {
  it('tolerates the @-prefixed form someone will inevitably configure', () => {
    expect(normalisePermittedDomain(' @Example.COM ')).toBe('example.com')
  })
})

describe('toPermittedDomainSet', () => {
  it('drops blank entries so a trailing comma cannot admit an empty domain', () => {
    expect([...toPermittedDomainSet(['example.com', '', '  '])]).toStrictEqual(['example.com'])
  })
})

describe('describeDomainRejection', () => {
  it('explains every reason without quoting the address that was offered', () => {
    for (const reason of [
      'missing-hd-claim',
      'domain-not-permitted',
      'email-not-verified',
    ] as const) {
      const message = describeDomainRejection(reason)
      expect(message.length).toBeGreaterThan(0)
      expect(message).not.toContain('@')
    }
  })
})
