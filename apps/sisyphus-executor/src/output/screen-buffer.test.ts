import { describe, expect, it } from 'vitest'

import type { ControlToken } from './control-tokens'
import { scanControlTokens } from './control-tokens'
import { createScreenBuffer } from './screen-buffer'

/* cspell:ignore Gfresh DXYZ Xdef Jnew mbold */

const ESC = String.fromCharCode(0x1b)

const feed = (input: string): ReturnType<typeof createScreenBuffer> => {
  const buffer = createScreenBuffer()

  for (const token of scanControlTokens(input).tokens) {
    buffer.apply(token)
  }

  return buffer
}

const textOf = (input: string): string[] =>
  feed(input)
    .takeRemainingRows()
    .map((row) => row.text)

describe('createScreenBuffer', () => {
  it('writes plain text into one row', () => {
    expect(textOf('hello')).toStrictEqual(['hello'])
  })

  it('starts a new row on a line feed', () => {
    expect(textOf('one\ntwo')).toStrictEqual(['one', 'two'])
  })

  it('overwrites from column zero after a carriage return', () => {
    expect(textOf('12345\rab')).toStrictEqual(['ab345'])
  })

  it('marks a row redrawn only when the cursor moved back over it', () => {
    const rows = feed('plain\nredrawn\rx').takeRemainingRows()

    expect(rows.map((row) => row.redrawn)).toStrictEqual([false, true])
  })

  it('clears the whole row for an erase-line 2', () => {
    expect(textOf(`stale content${ESC}[2K${ESC}[1Gfresh`)).toStrictEqual(['fresh'])
  })

  it('clears to the end of the row for an erase-line 0', () => {
    expect(textOf(`abcdefgh\rab${ESC}[K`)).toStrictEqual(['ab'])
  })

  it('moves the cursor back with a cursor-back sequence', () => {
    expect(textOf(`abcdef${ESC}[3DXYZ`)).toStrictEqual(['abcXYZ'])
  })

  it('moves the cursor to an absolute column', () => {
    expect(textOf(`abcdef${ESC}[3GX`)).toStrictEqual(['abXdef'])
  })

  it('pads with spaces when the cursor is moved forward past written cells', () => {
    expect(textOf(`ab${ESC}[3CX`)).toStrictEqual(['ab   X'])
  })

  it('rewrites an earlier row after a cursor-up sequence', () => {
    expect(textOf(`line one\nline two\n${ESC}[1Aline TWO`)).toStrictEqual([
      'line one',
      'line TWO',
      '',
    ])
  })

  it('backspace steps the cursor back one cell', () => {
    expect(textOf('abc\b\bX')).toStrictEqual(['aXc'])
  })

  it('resets everything on an erase-display 2', () => {
    expect(textOf(`old one\nold two${ESC}[2Jnew`)).toStrictEqual(['new'])
  })

  it('drops rows below the cursor on an erase-display 0', () => {
    expect(textOf(`a\nb\nc${ESC}[2A${ESC}[J`)).toStrictEqual(['a'])
  })

  it('clamps an absurd cursor movement instead of allocating for it', () => {
    const rows = feed(`x${ESC}[999999999BY`).takeRemainingRows()

    expect(rows.length).toBeLessThan(600)
    // Cursor-down keeps the column, so `Y` lands one cell in.
    expect(rows[rows.length - 1].text).toBe(' Y')
  })

  it('settles rows the cursor can no longer reach and retains the rest', () => {
    const buffer = feed('one\ntwo\nthree\nfour\n')
    const settled = buffer.takeSettledRows(2)

    expect(settled.map((row) => row.text)).toStrictEqual(['one', 'two', 'three'])
    expect(buffer.takeRemainingRows().map((row) => row.text)).toStrictEqual(['four', ''])
  })

  it('never settles the row the cursor is on', () => {
    const buffer = feed('unfinished')

    expect(buffer.takeSettledRows(0)).toStrictEqual([])
  })

  it('ignores presentation-only sequences', () => {
    const tokens: readonly ControlToken[] = scanControlTokens(
      `${ESC}[1m${ESC}[38;5;42mbold${ESC}[0m`,
    ).tokens
    const buffer = createScreenBuffer()

    for (const token of tokens) {
      buffer.apply(token)
    }

    expect(buffer.takeRemainingRows().map((row) => row.text)).toStrictEqual(['bold'])
  })
})
