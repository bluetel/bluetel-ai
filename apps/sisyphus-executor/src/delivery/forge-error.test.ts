/* cspell:words ratelimit */
import { describe, expect, it } from 'vitest'

import {
  forgeDetail,
  ForgeError,
  forgeErrorKindForStatus,
  httpForgeError,
  isNotFoundForgeError,
  isRetryableForgeError,
  MAX_FORGE_DETAIL_LENGTH,
  RETRYABLE_FORGE_ERROR_KINDS,
  retryAfterMsFrom,
  transportForgeError,
} from './forge-error'

/**
 * The distinction this module exists for is the one in
 * `branchHead`: "the host has no such branch" and "the request failed" must
 * never be the same value. Everything below is in service of that, plus the
 * rule that no failure carries a credential out with it (FR-072).
 */

const CREDENTIAL = 'ghp_s3cr3tForgeTokenValue00000000000'

/** Stands in for the client's known-value redactor. */
const redact = (text: string): string => text.split(CREDENTIAL).join('[redacted:credential]')

const headers = (values: Record<string, string> = {}): Headers => new Headers(values)

const NOW = 1_700_000_000_000

describe('forgeErrorKindForStatus', () => {
  it('reads 404 as the host saying there is no such thing', () => {
    expect(forgeErrorKindForStatus(404, headers())).toBe('not_found')
  })

  it('reads 401 as a credential problem, which no retry can fix', () => {
    expect(forgeErrorKindForStatus(401, headers())).toBe('unauthorised')
  })

  it('reads a 403 with budget remaining as a refusal, not a throttle', () => {
    // Hosts overload 403 for both. A permissions refusal retried three times
    // is one wrong token turned into three failed authentications.
    expect(forgeErrorKindForStatus(403, headers({ 'x-ratelimit-remaining': '4999' }))).toBe(
      'unauthorised',
    )
    expect(forgeErrorKindForStatus(403, headers())).toBe('unauthorised')
  })

  it('reads a 403 with the budget exhausted as a throttle', () => {
    expect(forgeErrorKindForStatus(403, headers({ 'x-ratelimit-remaining': '0' }))).toBe(
      'rate_limited',
    )
  })

  it('reads a 403 carrying a Retry-After as a secondary throttle', () => {
    expect(forgeErrorKindForStatus(403, headers({ 'retry-after': '30' }))).toBe('rate_limited')
  })

  it('reads 429 as a throttle', () => {
    expect(forgeErrorKindForStatus(429, headers())).toBe('rate_limited')
  })

  it('reads 409 and 422 as a refused state change, because that is how a duplicate arrives', () => {
    expect(forgeErrorKindForStatus(409, headers())).toBe('conflict')
    expect(forgeErrorKindForStatus(422, headers())).toBe('conflict')
  })

  it('reads 5xx and a request timeout as transient', () => {
    expect(forgeErrorKindForStatus(500, headers())).toBe('transient')
    expect(forgeErrorKindForStatus(502, headers())).toBe('transient')
    expect(forgeErrorKindForStatus(503, headers())).toBe('transient')
    expect(forgeErrorKindForStatus(408, headers())).toBe('transient')
  })

  it('reads any other 4xx as a request this client got wrong', () => {
    expect(forgeErrorKindForStatus(400, headers())).toBe('invalid')
    expect(forgeErrorKindForStatus(415, headers())).toBe('invalid')
  })
})

describe('retryAfterMsFrom', () => {
  it('prefers Retry-After, which is a duration and needs no clock agreement', () => {
    expect(retryAfterMsFrom(headers({ 'retry-after': '30' }), NOW)).toBe(30_000)
  })

  it('falls back to the reset time, measured against our own clock', () => {
    const reset = String((NOW + 45_000) / 1000)

    expect(retryAfterMsFrom(headers({ 'x-ratelimit-reset': reset }), NOW)).toBe(45_000)
  })

  it('never reports a negative wait for a reset already in the past', () => {
    const reset = String((NOW - 60_000) / 1000)

    expect(retryAfterMsFrom(headers({ 'x-ratelimit-reset': reset }), NOW)).toBe(0)
  })

  it('says nothing when the host said nothing', () => {
    expect(retryAfterMsFrom(headers(), NOW)).toBeUndefined()
  })

  it('ignores a value that is not a number rather than inventing one', () => {
    expect(retryAfterMsFrom(headers({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }), NOW)).toBe(
      undefined,
    )
  })
})

describe('isRetryableForgeError', () => {
  it('retries only the two kinds that mean "ask again later"', () => {
    expect([...RETRYABLE_FORGE_ERROR_KINDS].sort()).toStrictEqual(['rate_limited', 'transient'])
  })

  it.each(['rate_limited', 'transient'] as const)('retries %s', (kind) => {
    expect(isRetryableForgeError(new ForgeError({ kind, operation: 'branchHead' }))).toBe(true)
  })

  it.each(['not_found', 'unauthorised', 'conflict', 'invalid'] as const)(
    'does not retry %s',
    (kind) => {
      expect(isRetryableForgeError(new ForgeError({ kind, operation: 'branchHead' }))).toBe(false)
    },
  )

  it('does not treat an unrelated throw as retryable', () => {
    expect(isRetryableForgeError(new Error('something else'))).toBe(false)
  })
})

describe('isNotFoundForgeError', () => {
  it('identifies only the host saying there is no such thing', () => {
    expect(
      isNotFoundForgeError(new ForgeError({ kind: 'not_found', operation: 'branchHead' })),
    ).toBe(true)
    expect(
      isNotFoundForgeError(new ForgeError({ kind: 'transient', operation: 'branchHead' })),
    ).toBe(false)
    // The case the whole taxonomy is for: a dead socket is not an absent branch.
    expect(isNotFoundForgeError(new TypeError('fetch failed'))).toBe(false)
  })
})

describe('httpForgeError', () => {
  const failure = (status: number, body = '', values: Record<string, string> = {}) =>
    httpForgeError({
      operation: 'branchHead sisyphus/ACME-142 on acme/web',
      status,
      headers: headers(values),
      body,
      redact,
      nowMs: NOW,
    })

  it('names the status and the kind, which is what an operator acts on', () => {
    const error = failure(401, 'Bad credentials')

    expect(error.message).toContain('401')
    expect(error.message).toContain('unauthorised')
    expect(error.message).toContain('Bad credentials')
    expect(error.kind).toBe('unauthorised')
    expect(error.status).toBe(401)
  })

  it('carries the host’s own wait on a throttle, so the policy can honour it', () => {
    const error = failure(429, 'slow down', { 'retry-after': '12' })

    expect(error.kind).toBe('rate_limited')
    expect(error.retryAfterMs).toBe(12_000)
  })

  it('leaves retryAfterMs unset for a failure that is not a throttle', () => {
    expect(failure(500, 'boom').retryAfterMs).toBeUndefined()
  })

  it('redacts a body that echoes the credential back (FR-072)', () => {
    const error = failure(401, `Unauthorized for Bearer ${CREDENTIAL}`)

    expect(error.message).not.toContain(CREDENTIAL)
    expect(error.message).toContain('[redacted')
  })

  it('does not put a url in the message, because that is where a credential hides', () => {
    const error = failure(404, '')

    expect(error.message).not.toContain('http')
    expect(error.message).toContain('acme/web')
  })

  it('is an Error, so every existing catch site still works', () => {
    expect(failure(500)).toBeInstanceOf(Error)
    expect(failure(500).name).toBe('ForgeError')
  })
})

describe('forgeDetail', () => {
  it('bounds the body, so a response is never pasted whole into a run record', () => {
    const detail = forgeDetail('x'.repeat(5000), (text) => text)

    expect(detail.length).toBe(MAX_FORGE_DETAIL_LENGTH + 1)
    expect(detail.endsWith('…')).toBe(true)
  })

  it('redacts before it bounds, so a credential cannot survive the truncation', () => {
    expect(forgeDetail(`token ${CREDENTIAL}`, redact)).not.toContain(CREDENTIAL)
  })
})

describe('transportForgeError', () => {
  it('is always transient, because the host was never asked', () => {
    const error = transportForgeError(
      'branchHead on acme/web',
      new TypeError('fetch failed'),
      redact,
    )

    expect(error.kind).toBe('transient')
    expect(isNotFoundForgeError(error)).toBe(false)
    expect(error.message).toContain('fetch failed')
    expect(error.status).toBeUndefined()
  })

  it('keeps the cause, and redacts the message it quotes', () => {
    const cause = new Error(`connect failed using Bearer ${CREDENTIAL}`)
    const error = transportForgeError('createPullRequest on acme/web', cause, redact)

    expect(error.cause).toBe(cause)
    expect(error.message).not.toContain(CREDENTIAL)
  })

  it('says something rather than nothing when the throw was not an Error', () => {
    expect(transportForgeError('branchHead', 'nope', redact).message).toContain('did not complete')
  })
})
