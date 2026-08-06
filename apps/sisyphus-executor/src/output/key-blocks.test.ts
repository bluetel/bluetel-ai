import { describe, expect, it } from 'vitest'

import { createKeyBlockFilter, PRIVATE_KEY_PLACEHOLDER, stripPrivateKeyBlocks } from './key-blocks'

/** Synthetic. The body is filler text, not key material. */
const KEY_BLOCK = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'bm90LWEtcmVhbC1rZXktYm9keS1saW5lLW9uZS1maWxsZXItdGV4dA==',
  'bm90LWEtcmVhbC1rZXktYm9keS1saW5lLXR3by1maWxsZXItdGV4dA==',
  '-----END RSA PRIVATE KEY-----',
].join('\n')

/* cspell:ignore bm90 LWEt cmVh bC1r ZXkt Ym9k eS1s aW5l Zmlsb */

describe('stripPrivateKeyBlocks', () => {
  it('replaces a whole key block with one placeholder', () => {
    expect(stripPrivateKeyBlocks(`before\n${KEY_BLOCK}\nafter\n`)).toBe(
      `before\n${PRIVATE_KEY_PLACEHOLDER}\nafter\n`,
    )
  })

  it('handles the unlabelled header form', () => {
    const block = ['-----BEGIN PRIVATE KEY-----', 'ZmlsbGVy', '-----END PRIVATE KEY-----'].join(
      '\n',
    )

    expect(stripPrivateKeyBlocks(block)).toBe(`${PRIVATE_KEY_PLACEHOLDER}\n`)
  })

  it('leaves a certificate alone, because a certificate is public', () => {
    const certificate = [
      '-----BEGIN CERTIFICATE-----',
      'ZmlsbGVy',
      '-----END CERTIFICATE-----',
      '',
    ].join('\n')

    expect(stripPrivateKeyBlocks(certificate)).toBe(certificate)
  })

  it('handles two blocks in one stream', () => {
    expect(stripPrivateKeyBlocks(`${KEY_BLOCK}\n${KEY_BLOCK}\n`)).toBe(
      `${PRIVATE_KEY_PLACEHOLDER}\n${PRIVATE_KEY_PLACEHOLDER}\n`,
    )
  })

  it('drops a key whose end marker never arrives', () => {
    const truncated = KEY_BLOCK.split('\n').slice(0, 3).join('\n')
    const output = stripPrivateKeyBlocks(`${truncated}\n`)

    expect(output).toBe(`${PRIVATE_KEY_PLACEHOLDER}\n`)
  })

  it('leaves ordinary dashes alone', () => {
    const line = '----- summary -----\n'

    expect(stripPrivateKeyBlocks(line)).toBe(line)
  })

  it('leaves text untouched when there is no block', () => {
    expect(stripPrivateKeyBlocks('nothing to see\n')).toBe('nothing to see\n')
  })
})

describe('createKeyBlockFilter', () => {
  const collect = (chunks: readonly string[]): string => {
    const filter = createKeyBlockFilter()

    return chunks.map((chunk) => filter.push(chunk)).join('') + filter.flush()
  }

  it('never emits key body however the stream is chunked', () => {
    const input = `before\n${KEY_BLOCK}\nafter\n`
    const bodyLine = KEY_BLOCK.split('\n')[1]

    for (let split = 1; split < input.length; split += 1) {
      const output = collect([input.slice(0, split), input.slice(split)])

      expect(output).not.toContain(bodyLine)
      expect(output).toBe(`before\n${PRIVATE_KEY_PLACEHOLDER}\nafter\n`)
    }
  })

  it('recognises a header split one character at a time', () => {
    const input = `${KEY_BLOCK}\n`
    const output = collect(Array.from(input))

    expect(output).toBe(`${PRIVATE_KEY_PLACEHOLDER}\n`)
  })

  it('releases text that only looked like the start of a marker', () => {
    expect(collect(['tail ----', '- not a key\n'])).toBe('tail ----- not a key\n')
  })
})
