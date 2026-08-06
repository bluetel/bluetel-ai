import { describe, expect, it } from 'vitest'

import { sanitiseFailure } from './sanitise-failure'

describe('sanitiseFailure', () => {
  it('keeps the part that tells an admin what to fix', () => {
    expect(sanitiseFailure(new Error('401 Unauthorized'))).toBe('401 Unauthorized')
  })

  it('redacts an authorization header a client stringified into its error', () => {
    const message = sanitiseFailure(
      new Error('request failed: headers {authorization: Basic totally-not-a-real-token}'),
    )

    expect(message).not.toContain('totally-not-a-real-token')
    expect(message).toContain('Basic [redacted]')
  })

  it('redacts a bearer token', () => {
    expect(sanitiseFailure(new Error('Bearer abc.def.ghi rejected'))).toBe(
      'Bearer [redacted] rejected',
    )
  })

  it('redacts credentials embedded in a URL', () => {
    const message = sanitiseFailure(
      new Error(
        'ENOTFOUND https://ht@bluetel.co.uk:not-a-real-token@example.atlassian.net/rest/api/2/myself',
      ),
    )

    expect(message).not.toContain('not-a-real-token')
    expect(message).toContain('://[redacted]@')
  })

  it('redacts a named token in a query string', () => {
    const message = sanitiseFailure(new Error('GET /search?api_token=abcd1234&jql=project=SIS'))

    expect(message).not.toContain('abcd1234')
    expect(message).toContain('api_token=[redacted]')
    expect(message).toContain('jql=')
  })

  it('bounds the length, so a response body cannot be pasted into a run record', () => {
    expect(sanitiseFailure(new Error('x'.repeat(1000))).length).toBeLessThanOrEqual(301)
  })

  it('handles a thrown thing that is not an Error', () => {
    expect(sanitiseFailure('plain string failure')).toBe('plain string failure')
    expect(sanitiseFailure({ nope: true })).toContain('unrecognised')
  })
})
