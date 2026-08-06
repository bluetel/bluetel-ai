import { describe, expect, it } from 'vitest'

import { isSpinnerOnlyLine, stripLeadingSpinnerGlyph } from './spinner-frames'

describe('stripLeadingSpinnerGlyph', () => {
  it('removes a leading braille frame and keeps the message', () => {
    expect(stripLeadingSpinnerGlyph('⠋ Installing dependencies')).toBe('Installing dependencies')
  })

  it('keeps the indentation in front of the glyph', () => {
    expect(stripLeadingSpinnerGlyph('   ⠹ Resolving')).toBe('   Resolving')
  })

  it('removes a leading geometric frame', () => {
    expect(stripLeadingSpinnerGlyph('◓ Building')).toBe('Building')
  })

  it('leaves a Markdown list bullet alone', () => {
    expect(stripLeadingSpinnerGlyph('- install the bundle')).toBe('- install the bundle')
  })

  it('leaves a table rule alone', () => {
    expect(stripLeadingSpinnerGlyph('| id | name |')).toBe('| id | name |')
  })

  it('leaves a success mark alone', () => {
    expect(stripLeadingSpinnerGlyph('✔ done')).toBe('✔ done')
  })

  it('only removes the first glyph', () => {
    expect(stripLeadingSpinnerGlyph('⠋ ⠙ two frames')).toBe('⠙ two frames')
  })
})

describe('isSpinnerOnlyLine', () => {
  it('recognises a bare braille frame', () => {
    expect(isSpinnerOnlyLine('⠸')).toBe(true)
  })

  it('recognises a bare ASCII frame', () => {
    expect(isSpinnerOnlyLine('  /  ')).toBe(true)
  })

  it('does not treat a blank line as a spinner', () => {
    expect(isSpinnerOnlyLine('   ')).toBe(false)
  })

  it('does not treat a line with content as a spinner', () => {
    expect(isSpinnerOnlyLine('⠋ Installing')).toBe(false)
  })
})
