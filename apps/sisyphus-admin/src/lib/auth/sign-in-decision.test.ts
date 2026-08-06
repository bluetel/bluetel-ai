import { describe, expect, it } from 'vitest'

import type { SignInDecisionInput } from './sign-in-decision'
import { decideSignIn } from './sign-in-decision'

const input = (overrides: Partial<SignInDecisionInput> = {}): SignInDecisionInput => ({
  claims: { email: 'alice@bluetel.co.uk', email_verified: true, hd: 'bluetel.co.uk' },
  permittedDomains: ['bluetel.co.uk'],
  existingUser: { isActive: true },
  ...overrides,
})

describe('decideSignIn', () => {
  it('admits an active user from a permitted Workspace domain', () => {
    expect(decideSignIn(input())).toStrictEqual({
      allowed: true,
      domain: 'bluetel.co.uk',
      isFirstSignIn: false,
    })
  })

  it('flags a first sign-in, which is the seam T037 creates the user at (FR-170)', () => {
    expect(decideSignIn(input({ existingUser: undefined }))).toStrictEqual({
      allowed: true,
      domain: 'bluetel.co.uk',
      isFirstSignIn: true,
    })
  })

  it('refuses a deactivated user at sign-in (FR-176)', () => {
    expect(decideSignIn(input({ existingUser: { isActive: false } }))).toStrictEqual({
      allowed: false,
      refusal: { kind: 'deactivated' },
    })
  })

  it('refuses a domain we do not permit even when the address looks like ours', () => {
    expect(
      decideSignIn(
        input({
          claims: { email: 'alice@bluetel.co.uk', email_verified: true, hd: 'attacker.net' },
        }),
      ),
    ).toStrictEqual({ allowed: false, refusal: { kind: 'domain', reason: 'domain-not-permitted' } })
  })

  it('refuses a personal Google account whose address is on a permitted domain', () => {
    expect(
      decideSignIn(input({ claims: { email: 'alice@bluetel.co.uk', email_verified: true } })),
    ).toStrictEqual({ allowed: false, refusal: { kind: 'domain', reason: 'missing-hd-claim' } })
  })

  it('checks the domain before activation, so a refusal cannot confirm an address exists', () => {
    // A domain we do not permit, plus a deactivated row: the reason reported is the domain, never the
    // deactivation, because the second would tell a stranger that this person has an account.
    expect(
      decideSignIn(
        input({
          claims: { email: 'alice@attacker.net', email_verified: true, hd: 'attacker.net' },
          existingUser: { isActive: false },
        }),
      ),
    ).toStrictEqual({ allowed: false, refusal: { kind: 'domain', reason: 'domain-not-permitted' } })
  })
})
