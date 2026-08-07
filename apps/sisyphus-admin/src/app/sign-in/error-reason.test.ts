import { describe, expect, it } from 'vitest'

import { AUTH_ERROR_REASONS, authErrorReason, REFUSAL_CAUSES } from './error-reason'

/**
 * Two things are being protected here.
 *
 * The first is ordinary: the three causes FR-195 asks for are reachable and readable, and an
 * unauthenticated visit with no parameter shows no error at all.
 *
 * The second is the one worth writing tests for. A sign-in screen is the cheapest place in a
 * platform to build an account-existence oracle, and the way it happens is not malice — it is a
 * helpful message. "That account has been deactivated" is helpful, and it answers *is this address
 * a Sisyphus user?* for anyone who can type a URL. FR-190 spends the whole platform's error
 * vocabulary avoiding that answer, so the invariants below are asserted over the entire reason
 * vocabulary rather than over one string, and they hold for reasons added later.
 */

/** Every parameter value the screen can be reached with, real and invented. */
const PARAMETERS = [
  'AccessDenied',
  'Configuration',
  'Verification',
  'OAuthSignin',
  'OAuthCallbackError',
  'OAuthAccountNotLinked',
  'CallbackRouteError',
  'SessionRequired',
  'deactivated',
  'account-not-found',
  'alice@example.com',
  '<script>alert(1)</script>',
]

const everyReason = () => Object.values(AUTH_ERROR_REASONS)

describe('authErrorReason', () => {
  it('shows nothing for an ordinary unauthenticated visit', () => {
    expect(authErrorReason(undefined)).toBeUndefined()
    expect(authErrorReason('')).toBeUndefined()
    expect(authErrorReason('   ')).toBeUndefined()
    expect(authErrorReason([])).toBeUndefined()
  })

  it('names the refusal for the code Auth.js sends when the sign-in gate says no', () => {
    const reason = authErrorReason('AccessDenied')

    expect(reason).toBe(AUTH_ERROR_REASONS.refused)
    expect(reason?.summary).toContain(REFUSAL_CAUSES.domain)
    expect(reason?.summary).toContain(REFUSAL_CAUSES.deactivated)
  })

  it('separates a misconfigured deployment from a failed provider round trip', () => {
    expect(authErrorReason('Configuration')).toBe(AUTH_ERROR_REASONS.configuration)
    expect(authErrorReason('OAuthCallbackError')).toBe(AUTH_ERROR_REASONS.provider)
    expect(AUTH_ERROR_REASONS.configuration.action).toContain('Retrying will not help')
  })

  it('falls back to the generic failure for a code it does not know', () => {
    expect(authErrorReason('SomethingNobodyShipped')).toBe(AUTH_ERROR_REASONS.provider)
  })

  it('is total over a hand-written URL, and never invents an error out of a malformed one', () => {
    // A repeated parameter is read as its first value, which is what a URL means by it.
    expect(authErrorReason(['AccessDenied', 'Configuration'])).toBe(AUTH_ERROR_REASONS.refused)
    // A shape that is not a string carries no code, so it is an absent parameter rather than an
    // unknown one — reporting a failure to somebody who has not had one is its own defect.
    expect(authErrorReason(42)).toBeUndefined()
    expect(authErrorReason({ error: 'AccessDenied' })).toBeUndefined()
    expect(authErrorReason([42])).toBeUndefined()
  })

  it('carries a code and a next action on every reason, never a dead end (FR-031)', () => {
    for (const reason of everyReason()) {
      expect(reason.code).toMatch(/^E_AUTH_[A-Z]+$/)
      expect(reason.action.length).toBeGreaterThan(0)
      expect(reason.summary.length).toBeGreaterThan(0)
    }
  })
})

describe('a reason as an account-existence oracle (FR-190, FR-195)', () => {
  it('never states that access was withdrawn without also offering the out-of-domain cause', () => {
    // The invariant, and the reason the two causes are one reason: `deactivated` is only ever
    // readable as one of two possibilities. Alone it would confirm the identity is known to the
    // platform; beside `domain` it confirms nothing, because the reader cannot tell which applies.
    const mentionsWithdrawal = everyReason().filter((reason) =>
      reason.summary.includes(REFUSAL_CAUSES.deactivated),
    )

    // Not vacuous: FR-195 requires the deactivated cause to be reachable and readable.
    expect(mentionsWithdrawal.length).toBeGreaterThan(0)

    for (const reason of mentionsWithdrawal) {
      expect(reason.summary).toContain(REFUSAL_CAUSES.domain)
      expect(reason.summary).toMatch(/does not say which/i)
    }
  })

  it('never asserts that an account exists, is registered, or is unknown', () => {
    // The phrasings that turn a cause into a finding about a specific identity.
    const disclosure =
      /\b(exists?|registered|on file|we know|no such|not recognised|not recognized|unknown (account|user)|your account|this user)\b/i

    for (const reason of everyReason()) {
      expect(`${reason.summary} ${reason.action}`).not.toMatch(disclosure)
    }
  })

  it('never names an address, so no reason can be read as being about one identity', () => {
    for (const reason of everyReason()) {
      expect(`${reason.summary} ${reason.action}`).not.toContain('@')
    }
  })

  it('reflects nothing from the query parameter into what it renders', () => {
    // A reason built by interpolating the parameter would be both an injection surface and, worse,
    // a way to make the screen appear to be talking about a specific address. Every answer is one
    // of the three objects declared in the module; none is constructed from input.
    for (const parameter of PARAMETERS) {
      const reason = authErrorReason(parameter)

      expect(everyReason()).toContain(reason)
      expect(reason === undefined ? '' : `${reason.summary} ${reason.action}`).not.toContain(
        parameter,
      )
    }
  })

  it('answers identically however it is reached, so it can report nothing about an account', () => {
    // Purity restated as behaviour: the same parameter gives the same object every time, and the
    // function has no other input it could vary with.
    expect(authErrorReason('AccessDenied')).toBe(authErrorReason('AccessDenied'))
    expect(authErrorReason('AccessDenied')).toBe(authErrorReason(['AccessDenied']))
  })
})
