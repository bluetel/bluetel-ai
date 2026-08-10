import { describe, expect, it } from 'vitest'

import type { ProviderResponse } from './classify'
import { classifyProviderResponse } from './classify'

/**
 * **T082 — classification against recorded provider responses (research R5).**
 *
 * ## Why these are recordings and not a live call
 *
 * The obvious acceptance step for "a rate limit is not a breakage" is to provoke a rate limit and
 * watch. It is also the wrong one, and deliberately not what this suite does. Provoking a real
 * limit means deliberately exhausting a real subscription's quota — the same quota the platform's
 * own runs draw on — to observe a response whose shape is already known; it takes as long as the
 * limit takes to clear, it cannot be run twice in a morning, and it produces exactly one sample. A
 * recorded response is the same evidence, available every time the suite runs, for every shape at
 * once, including the ones nobody can provoke on demand: the 403 that is really a plan limit, the
 * `Retry-After` given as an HTTP-date, the connection that never completed.
 *
 * So the fixtures below are **recordings**: status, headers, body and code as a provider actually
 * sends them, with nothing invented except the timestamps, which are pinned so a relative
 * `Retry-After` has a deterministic deadline. What they cannot prove is that a provider has not
 * changed its shape since the day they were captured, and no fixture ever could. That gap is
 * closed by the ambiguous default rather than by a live call: a response this file has never seen
 * resolves to `cooling_off`, and a credential wrongly cooled off comes back by itself.
 *
 * ## The three cases the task names, and the fourth the design turns on
 *
 * Rate limit ⇒ `cooling_off`; auth failure ⇒ `unhealthy`; ambiguous ⇒ `cooling_off`. The fourth is
 * the **precedence** between the first two, because real responses carry both signals: a 403 whose
 * body says the usage limit was reached must not take a live credential out of the pool and page
 * somebody for a limit that clears in an hour.
 */

/** Pinned, so a relative `Retry-After` resolves to a deadline a test can state. */
const RECEIVED_AT = new Date('2026-03-01T12:00:00.000Z')

/**
 * Recorded refusals, verbatim in shape.
 *
 * Bodies are truncated to the part that carries the signal, and nothing has been added to them —
 * in particular, the `id` and `request_id` fields real responses carry are dropped rather than
 * anonymised, because a fixture is only evidence if what is in it is what came back.
 */
const RECORDED = {
  /** The ordinary rate limit: 429, a delay in whole seconds, a machine-readable code. */
  rateLimitWithRetryAfter: {
    status: 429,
    headers: { 'Retry-After': '900', 'Content-Type': 'application/json' },
    code: 'rate_limit_error',
    body: '{"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit. Please try again later."}}',
  },

  /** The same limit expressed as an absolute reset, which is the other convention in circulation. */
  rateLimitWithResetHeader: {
    status: 429,
    headers: { 'x-ratelimit-reset': String(Math.floor(RECEIVED_AT.getTime() / 1000) + 1800) },
    body: '{"error":{"message":"Rate limit reached for requests"}}',
  },

  /** `Retry-After` as an HTTP-date. Specified, less common, and trivially misread as a delay. */
  rateLimitWithHttpDate: {
    status: 429,
    headers: { 'retry-after': 'Sun, 01 Mar 2026 12:45:00 GMT' },
    body: 'Too Many Requests',
  },

  /**
   * A monthly usage limit, which is not a rate limit and is also not a breakage. Sent as 429 with
   * no reset at all by some providers and as 402 by others — both are here.
   */
  usageLimitWithNoResetTime: {
    status: 429,
    code: 'usage_limit_reached',
    body: '{"error":{"type":"usage_limit_reached","message":"You have reached your monthly usage limit for this plan."}}',
  },

  planLimit: {
    status: 402,
    body: '{"error":{"message":"Your plan\'s included usage has been consumed."}}',
  },

  /**
   * A plan limit delivered as **403**, which is otherwise the clearest authorisation refusal there
   * is. This is the recording the precedence rule exists for.
   */
  limitDeliveredAsForbidden: {
    status: 403,
    body: '{"error":{"message":"Organization has exceeded its usage quota."}}',
  },

  /** The credential is not good: revoked, rotated out from under us, or never valid. */
  invalidApiKey: {
    status: 401,
    code: 'authentication_error',
    body: '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
  },

  /** A subscription login whose session has been invalidated — the R1 rotation case, observed. */
  expiredSession: {
    status: 401,
    body: '{"error":{"message":"OAuth token has expired. Please re-authenticate."}}',
  },

  /** Authorisation rather than authentication: the identity is real and may not do this. */
  forbidden: {
    status: 403,
    body: '{"error":{"message":"Unauthorized: this credential is not permitted to use this model."}}',
  },

  /** A provider fault. Says nothing about the credential at all. */
  serverError: {
    status: 500,
    body: '{"error":{"message":"Internal server error"}}',
  },

  /** A gateway that answered before the provider did. Also says nothing. */
  badGateway: {
    status: 502,
    body: '<html><head><title>502 Bad Gateway</title></head></html>',
  },

  /** No response at all: DNS, TLS, a socket that closed. There is no status to read. */
  transportFailure: {} satisfies ProviderResponse,
} satisfies Record<string, ProviderResponse>

describe('classifyProviderResponse — a rate or usage limit is not a breakage (FR-075, SC-019)', () => {
  it('reads a 429 with Retry-After as cooling off, with the provider’s reset time (FR-078)', () => {
    const verdict = classifyProviderResponse(RECORDED.rateLimitWithRetryAfter, RECEIVED_AT)

    expect(verdict.state).toBe('cooling_off')
    expect(verdict.signal).toBe('rate_limit')
    // 900 seconds after the response was received, not 900 seconds after whenever this test ran.
    expect(verdict.coolingOffUntil).toStrictEqual(new Date('2026-03-01T12:15:00.000Z'))
  })

  it('reads an absolute reset header as the instant it names', () => {
    const verdict = classifyProviderResponse(RECORDED.rateLimitWithResetHeader, RECEIVED_AT)

    expect(verdict.state).toBe('cooling_off')
    expect(verdict.coolingOffUntil).toStrictEqual(new Date('2026-03-01T12:30:00.000Z'))
  })

  it('reads Retry-After given as an HTTP-date rather than treating it as a delay', () => {
    const verdict = classifyProviderResponse(RECORDED.rateLimitWithHttpDate, RECEIVED_AT)

    expect(verdict.state).toBe('cooling_off')
    expect(verdict.coolingOffUntil).toStrictEqual(new Date('2026-03-01T12:45:00.000Z'))
  })

  it('cools off with no stated time when the provider named none (FR-078)', () => {
    const verdict = classifyProviderResponse(RECORDED.usageLimitWithNoResetTime, RECEIVED_AT)

    expect(verdict.state).toBe('cooling_off')
    expect(verdict.signal).toBe('rate_limit')
    // The case the FR-078 sweep exists for. `undefined` here means "retry on the configured
    // interval", and it must not be filled in with a guess — the pool view shows this to an
    // administrator as an expected return time, and an invented one would be a lie on a screen.
    expect(verdict.coolingOffUntil).toBeUndefined()
    expect(verdict.reason).toContain('named no reset time')
  })

  it('treats a plan or quota exhaustion as a limit, whatever status carries it', () => {
    for (const recorded of [RECORDED.planLimit, RECORDED.limitDeliveredAsForbidden]) {
      expect(classifyProviderResponse(recorded, RECEIVED_AT).state).toBe('cooling_off')
    }
  })

  it('lets the limit signal win over the auth signal when a response carries both', () => {
    // A 403 whose body says the quota is exhausted. Classified the other way round it would take a
    // perfectly good credential out of the pool and page somebody for something that clears itself.
    const verdict = classifyProviderResponse(RECORDED.limitDeliveredAsForbidden, RECEIVED_AT)

    expect(verdict.state).toBe('cooling_off')
    expect(verdict.signal).toBe('rate_limit')
  })
})

describe('classifyProviderResponse — a broken login needs a person (FR-033, FR-037)', () => {
  it('marks an invalid credential unhealthy', () => {
    const verdict = classifyProviderResponse(RECORDED.invalidApiKey, RECEIVED_AT)

    expect(verdict.state).toBe('unhealthy')
    expect(verdict.signal).toBe('auth_failure')
    expect(verdict.coolingOffUntil).toBeUndefined()
  })

  it('marks an expired or revoked session unhealthy rather than waiting for it to clear', () => {
    // It will not clear. Waiting would leave the seat out of the pool for exactly as long as it
    // takes somebody to notice by other means, which is what the alert exists to shorten.
    expect(classifyProviderResponse(RECORDED.expiredSession, RECEIVED_AT).state).toBe('unhealthy')
  })

  it('marks an authorisation refusal unhealthy', () => {
    expect(classifyProviderResponse(RECORDED.forbidden, RECEIVED_AT).state).toBe('unhealthy')
  })

  it('never states a return time for a broken login', () => {
    for (const recorded of [RECORDED.invalidApiKey, RECORDED.expiredSession, RECORDED.forbidden]) {
      expect(classifyProviderResponse(recorded, RECEIVED_AT).coolingOffUntil).toBeUndefined()
    }
  })
})

describe('classifyProviderResponse — the ambiguous case resolves to cooling off (research R5)', () => {
  it('cools off on a provider fault rather than blaming the credential', () => {
    const verdict = classifyProviderResponse(RECORDED.serverError, RECEIVED_AT)

    expect(verdict.state).toBe('cooling_off')
    expect(verdict.signal).toBe('ambiguous')
  })

  it('cools off on a gateway error whose body is not even JSON', () => {
    expect(classifyProviderResponse(RECORDED.badGateway, RECEIVED_AT).state).toBe('cooling_off')
  })

  it('cools off when there was no response at all', () => {
    const verdict = classifyProviderResponse(RECORDED.transportFailure, RECEIVED_AT)

    expect(verdict.state).toBe('cooling_off')
    expect(verdict.signal).toBe('ambiguous')
    expect(verdict.reason).toContain('no status')
  })

  it('never reaches unhealthy without a positive authentication signal', () => {
    // The invariant the asymmetry rests on, stated over a set of responses none of which says
    // anything about the login: not one of them may take a credential out of the pool.
    const unclassifiable: readonly ProviderResponse[] = [
      RECORDED.serverError,
      RECORDED.badGateway,
      RECORDED.transportFailure,
      { status: 418 },
      { status: 503, body: 'service unavailable' },
      { body: '' },
      { code: 'something_nobody_has_seen' },
    ]

    for (const response of unclassifiable) {
      expect(classifyProviderResponse(response, RECEIVED_AT).state).toBe('cooling_off')
    }
  })
})

describe('classifyProviderResponse — what the reason may contain (SC-014, FR-009)', () => {
  it('never quotes the provider’s body, which nobody controls the contents of', () => {
    const echoed = 'sk-not-a-real-key-0000000000000000000000000000000000'
    const verdict = classifyProviderResponse(
      { status: 401, body: `{"error":{"message":"invalid api key: ${echoed}"}}` },
      RECEIVED_AT,
    )

    // Classified from the body, and not repeated from it. `last_failure_reason` is rendered to
    // every administrator verbatim, and a provider that echoes the offending header back into its
    // error message is an ordinary thing for an HTTP API to do.
    expect(verdict.state).toBe('unhealthy')
    expect(verdict.reason).not.toContain(echoed)
    expect(verdict.reason).not.toContain('sk-')
  })

  it('quotes the provider’s own error code, which is a bounded vocabulary', () => {
    expect(classifyProviderResponse(RECORDED.invalidApiKey, RECEIVED_AT).reason).toContain(
      'authentication_error',
    )
  })

  it('says which way an ambiguous response was resolved, and why', () => {
    const verdict = classifyProviderResponse(RECORDED.serverError, RECEIVED_AT)

    expect(verdict.reason).toContain('neither a usage limit nor an authentication failure')
    expect(verdict.reason).toContain('returns by itself')
  })
})

describe('classifyProviderResponse — reset times that cannot be believed', () => {
  it('ignores a reset already in the past rather than returning the credential immediately', () => {
    // A clock skew, or a response sat in a retry queue. Believing it would convert "the provider
    // told us to wait" into "we did not wait", against a provider that is already refusing.
    const verdict = classifyProviderResponse(
      { status: 429, headers: { 'retry-after': 'Sun, 01 Mar 2026 11:00:00 GMT' } },
      RECEIVED_AT,
    )

    expect(verdict.state).toBe('cooling_off')
    expect(verdict.coolingOffUntil).toBeUndefined()
  })

  it('ignores a reset header it cannot parse', () => {
    const verdict = classifyProviderResponse(
      { status: 429, headers: { 'Retry-After': 'soon' } },
      RECEIVED_AT,
    )

    expect(verdict.coolingOffUntil).toBeUndefined()
  })

  it('reads a reset header as a limit signal even without a limit status', () => {
    // Nothing but a limit has a reason to send one, so a 200-shaped refusal carrying `Retry-After`
    // is still a limit. This is the one place a header alone decides the classification.
    const verdict = classifyProviderResponse(
      { status: 503, headers: { 'Retry-After': '60' } },
      RECEIVED_AT,
    )

    expect(verdict.signal).toBe('rate_limit')
    expect(verdict.coolingOffUntil).toStrictEqual(new Date('2026-03-01T12:01:00.000Z'))
  })
})
