import { describe, expect, it } from 'vitest'

import { scanControlTokens } from './control-tokens'

/* cspell:ignore mred Bplain */

const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const NUL = String.fromCharCode(0x00)

describe('scanControlTokens', () => {
  it('keeps printable text as a single token', () => {
    expect(scanControlTokens('hello world').tokens).toStrictEqual([
      { kind: 'text', value: 'hello world' },
    ])
  })

  it('parses a colour sequence into a csi token rather than text', () => {
    const { tokens } = scanControlTokens(`${ESC}[31mred${ESC}[0m`)

    expect(tokens).toStrictEqual([
      { kind: 'csi', finalByte: 'm', params: [31] },
      { kind: 'text', value: 'red' },
      { kind: 'csi', finalByte: 'm', params: [0] },
    ])
  })

  it('parses multiple parameters and ignores sub-parameters', () => {
    const { tokens } = scanControlTokens(`${ESC}[38:2:255:0:0;1m`)

    expect(tokens).toStrictEqual([{ kind: 'csi', finalByte: 'm', params: [38, 1] }])
  })

  it('drops private-mode sequences entirely', () => {
    expect(scanControlTokens(`${ESC}[?25lx${ESC}[?25h`).tokens).toStrictEqual([
      { kind: 'text', value: 'x' },
    ])
  })

  it('drops an operating-system command terminated by BEL', () => {
    expect(scanControlTokens(`${ESC}]0;window title${BEL}after`).tokens).toStrictEqual([
      { kind: 'text', value: 'after' },
    ])
  })

  it('drops an operating-system command terminated by the string terminator', () => {
    expect(scanControlTokens(`${ESC}]8;;https://example.test${ESC}\\after`).tokens).toStrictEqual([
      { kind: 'text', value: 'after' },
    ])
  })

  it('drops a two-character escape with intermediates', () => {
    expect(scanControlTokens(`${ESC}(Bplain`).tokens).toStrictEqual([
      { kind: 'text', value: 'plain' },
    ])
  })

  it('emits line-feed, carriage-return and backspace as tokens', () => {
    expect(scanControlTokens('a\rb\nc\bd').tokens).toStrictEqual([
      { kind: 'text', value: 'a' },
      { kind: 'carriage-return' },
      { kind: 'text', value: 'b' },
      { kind: 'line-feed' },
      { kind: 'text', value: 'c' },
      { kind: 'backspace' },
      { kind: 'text', value: 'd' },
    ])
  })

  it('keeps tabs as printable content', () => {
    expect(scanControlTokens('a\tb').tokens).toStrictEqual([{ kind: 'text', value: 'a\tb' }])
  })

  it('discards other control characters', () => {
    expect(scanControlTokens(`a${BEL}${NUL}b`).tokens).toStrictEqual([
      { kind: 'text', value: 'ab' },
    ])
  })

  it('hands back an incomplete trailing sequence when streaming', () => {
    const scan = scanControlTokens(`text${ESC}[3`, { allowIncomplete: true })

    expect(scan.tokens).toStrictEqual([{ kind: 'text', value: 'text' }])
    expect(scan.remainder).toBe(`${ESC}[3`)
  })

  it('discards an incomplete trailing sequence when not streaming', () => {
    const scan = scanControlTokens(`text${ESC}[3`)

    expect(scan.tokens).toStrictEqual([{ kind: 'text', value: 'text' }])
    expect(scan.remainder).toBe('')
  })

  it('does not let an unterminated string sequence swallow the stream', () => {
    const scan = scanControlTokens(`${ESC}]${'x'.repeat(5000)}tail`)
    const text = scan.tokens.map((token) => (token.kind === 'text' ? token.value : '')).join('')

    expect(text.endsWith('tail')).toBe(true)
  })
})
