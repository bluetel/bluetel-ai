import { Buffer } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import { createRedactor, createStreamingRedactor } from './redact'
import type { KnownSecret } from './secret-values'

/**
 * Synthetic throughout. Nothing here is, resembles, or could be mistaken for a
 * credential belonging to any real service.
 */
const AGENT_VALUE = 'not-a-real-agent-credential-0123456789'
const SECRETS: readonly KnownSecret[] = [{ name: 'agent-credential', value: AGENT_VALUE }]

/* cspell:ignore AKIAEXAMPLENOTREAL Zmlsb Qtbm Wtle Rlcmlhb */

const KEY_BLOCK = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'ZmlsbGVyLXRleHQtbm90LWtleS1tYXRlcmlhbA==',
  '-----END RSA PRIVATE KEY-----',
].join('\n')

describe('createRedactor', () => {
  const redactor = createRedactor({ secrets: SECRETS })

  it('removes a known value', () => {
    expect(redactor.redact(`using ${AGENT_VALUE}\n`)).toBe('using [redacted:agent-credential]\n')
  })

  it('removes a credential matched only by shape', () => {
    expect(redactor.redact('id AKIAEXAMPLENOTREAL01\n')).toBe('id [redacted:aws-access-key-id]\n')
  })

  it('names a known value by the bundle name rather than by a pattern', () => {
    const patterned = createRedactor({
      secrets: [{ name: 'agent-credential', value: 'AKIAEXAMPLENOTREAL01' }],
    })

    expect(patterned.redact('AKIAEXAMPLENOTREAL01')).toBe('[redacted:agent-credential]')
  })

  it('removes a private key block', () => {
    expect(redactor.redact(`${KEY_BLOCK}\n`)).toBe('[redacted:private-key]\n')
  })

  it('works with no secrets installed at all', () => {
    expect(createRedactor().redact('plain output\n')).toBe('plain output\n')
  })
})

describe('createStreamingRedactor', () => {
  const collect = (chunks: readonly string[], secrets = SECRETS): string => {
    const redactor = createStreamingRedactor({ secrets })

    return chunks.map((chunk) => redactor.push(chunk)).join('') + redactor.flush()
  }

  it('matches the batch redactor for a single chunk', () => {
    const input = `line one\nusing ${AGENT_VALUE}\nline three\n`

    expect(collect([input])).toBe(createRedactor({ secrets: SECRETS }).redact(input))
  })

  it('catches a secret split across a chunk boundary at every split point', () => {
    const input = `prefix ${AGENT_VALUE} suffix\n`

    for (let split = 1; split < input.length; split += 1) {
      const output = collect([input.slice(0, split), input.slice(split)])

      expect(output).not.toContain(AGENT_VALUE)
      expect(output).toBe('prefix [redacted:agent-credential] suffix\n')
    }
  })

  it('catches a secret delivered one character per chunk', () => {
    const input = `token=${AGENT_VALUE}\n`
    const output = collect(Array.from(input))

    expect(output).not.toContain(AGENT_VALUE)
    expect(output).toContain('[redacted:agent-credential]')
  })

  it('catches a base64-encoded secret split across a chunk boundary', () => {
    const blob = Buffer.from(`payload${AGENT_VALUE}tail`, 'utf8').toString('base64')
    const input = `body=${blob}\n`

    for (let split = 1; split < input.length; split += 3) {
      const output = collect([input.slice(0, split), input.slice(split)])

      expect(output).toContain('[redacted:agent-credential]')
      expect(output).not.toBe(input)
    }
  })

  it('never releases key body however the key is chunked', () => {
    const input = `before\n${KEY_BLOCK}\nafter\n`
    const bodyLine = KEY_BLOCK.split('\n')[1]

    for (let split = 1; split < input.length; split += 1) {
      expect(collect([input.slice(0, split), input.slice(split)])).not.toContain(bodyLine)
    }
  })

  it('holds a partial line back until the line is complete', () => {
    const redactor = createStreamingRedactor()

    expect(redactor.push('partial ')).toBe('')
    expect(redactor.push('line\n')).toBe('partial line\n')
  })

  it('holds back at least the longest matchable form when secrets are installed', () => {
    const redactor = createStreamingRedactor({ secrets: SECRETS })

    // A complete line is still not releasable while it is short enough that a
    // secret could straddle its end.
    expect(redactor.push('short line\n')).toBe('')
    expect(redactor.push('filler line\n'.repeat(40))).toContain('short line\n')
  })

  it('releases everything on flush', () => {
    const redactor = createStreamingRedactor({ secrets: SECRETS })

    redactor.push('no terminator')

    expect(redactor.flush()).toBe('no terminator')
  })

  it('loses nothing when no secrets are installed', () => {
    const input = 'one\ntwo\nthree'

    expect(collect([input], [])).toBe(input)
  })

  it('preserves ordering and content across many chunks', () => {
    const lines = Array.from({ length: 200 }, (_unused, line) => `line ${line}\n`)

    expect(collect(lines, [])).toBe(lines.join(''))
  })
})
