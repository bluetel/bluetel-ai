import { Buffer } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import { buildSecretIndex } from './secret-values'

/**
 * Synthetic throughout. Nothing here is, resembles, or could be mistaken for a
 * credential belonging to any real service.
 */
const AGENT_VALUE = 'not-a-real-agent-credential-0123456789'
const TRACKER_VALUE = 'not-a-real-tracker-credential-abcdefgh'

const index = buildSecretIndex([
  { name: 'agent-credential', value: AGENT_VALUE },
  { name: 'tracker-credential', value: TRACKER_VALUE },
])

describe('buildSecretIndex', () => {
  it('removes a value verbatim', () => {
    expect(index.redact(`token is ${AGENT_VALUE} now`)).toBe(
      'token is [redacted:agent-credential] now',
    )
  })

  it('removes every occurrence, not just the first', () => {
    const redacted = index.redact(`${AGENT_VALUE} and ${AGENT_VALUE}`)

    expect(redacted).not.toContain(AGENT_VALUE)
    expect(redacted).toBe('[redacted:agent-credential] and [redacted:agent-credential]')
  })

  it('names each credential separately', () => {
    const redacted = index.redact(`${AGENT_VALUE} ${TRACKER_VALUE}`)

    expect(redacted).toBe('[redacted:agent-credential] [redacted:tracker-credential]')
  })

  it('removes a value embedded in a base64 blob', () => {
    const blob = Buffer.from(`prefix${AGENT_VALUE}suffix`, 'utf8').toString('base64')
    const redacted = index.redact(`body=${blob}`)

    expect(redacted).toContain('[redacted:agent-credential]')
    expect(redacted).not.toBe(`body=${blob}`)
  })

  it('removes a percent-encoded value', () => {
    const value = 'not a real credential with spaces'
    const spaced = buildSecretIndex([{ name: 'bundle-credential', value }])
    const redacted = spaced.redact(`https://example.test/?t=${encodeURIComponent(value)}`)

    expect(redacted).toBe('https://example.test/?t=[redacted:bundle-credential]')
  })

  it('removes a hex-encoded value', () => {
    const hex = Buffer.from(AGENT_VALUE, 'utf8').toString('hex')

    expect(index.redact(hex)).toBe('[redacted:agent-credential]')
  })

  it('does not leak the length of what it removed', () => {
    const short = buildSecretIndex([{ name: 'credential', value: 'shortish-secret' }])
    const long = buildSecretIndex([{ name: 'credential', value: 'x'.repeat(512) }])

    expect(short.redact('shortish-secret')).toBe(long.redact('x'.repeat(512)))
  })

  it('ignores a value too short to be a credential', () => {
    const tiny = buildSecretIndex([{ name: 'credential', value: 'abc' }])

    expect(tiny.isEmpty).toBe(true)
    expect(tiny.redact('abc def abc')).toBe('abc def abc')
  })

  it('falls back to a neutral label for a name that is not safe to print', () => {
    const odd = buildSecretIndex([
      { name: 'name with spaces and ]brackets[', value: 'not-a-real-value-000' },
    ])

    expect(odd.redact('not-a-real-value-000')).toBe('[redacted:credential]')
  })

  it('reports the longest matchable form so a streaming caller can hold enough back', () => {
    expect(index.longestMatchLength).toBeGreaterThan(AGENT_VALUE.length)
  })

  it('is empty for no secrets at all', () => {
    const empty = buildSecretIndex([])

    expect(empty.isEmpty).toBe(true)
    expect(empty.longestMatchLength).toBe(0)
    expect(empty.redact('untouched')).toBe('untouched')
  })
})
