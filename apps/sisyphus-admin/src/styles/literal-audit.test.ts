import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { findDesignLiterals } from './literal-audit'

describe('findDesignLiterals', () => {
  it('reports a hex colour', () => {
    expect(findDesignLiterals("const a = '#1B4FE0'")).toStrictEqual([{ line: 1, value: '#1B4FE0' }])
  })

  it('reports a colour function', () => {
    expect(findDesignLiterals('const a = rgba(0, 0, 0, 0.3)')).toStrictEqual([
      { line: 1, value: 'rgba(' },
    ])
  })

  it.each(['12px', '1.5rem', '0.11em', '52ch', '5.4vw'])('reports the length %s', (length) => {
    expect(findDesignLiterals(`const a = '${length}'`)).toStrictEqual([{ line: 1, value: length }])
  })

  it('ignores a value quoted in a line comment, so prose can name what it describes', () => {
    expect(findDesignLiterals('// a 6px square LED in #1B4FE0')).toStrictEqual([])
  })

  it('ignores a value quoted in a block comment', () => {
    expect(findDesignLiterals('/**\n * 2px inset shade\n */\nconst a = 1')).toStrictEqual([])
  })

  it('keeps line numbers accurate after stripping a block comment', () => {
    expect(
      findDesignLiterals('/* 2px */\nconst a = 1\nconst b = 3\nconst c = 4;\nlet d = 12px'),
    ).toStrictEqual([{ line: 5, value: '12px' }])
  })

  it('passes a token-only component, which is what compliance looks like', () => {
    expect(
      findDesignLiterals("<div className='bg-paper p-close rounded-md border-hairline' />"),
    ).toStrictEqual([])
  })

  it('does not mistake an identifier ending in a unit for a length', () => {
    expect(findDesignLiterals('const grid2rem = 1')).toStrictEqual([])
  })
})

/**
 * The audit applied to the thing it exists for. Every primitive is scanned, so a literal added to
 * a component in a later task fails here rather than at design review.
 */
describe('the shared primitive set', () => {
  const uiDirectory = fileURLToPath(new URL('../components/ui', import.meta.url))
  const sources = readdirSync(uiDirectory).filter((name) => !name.includes('.test.'))

  it('contains primitives to audit', () => {
    expect(sources.length).toBeGreaterThan(0)
  })

  it.each(sources)('%s carries no literal colour, size or radius', (name) => {
    expect(findDesignLiterals(readFileSync(`${uiDirectory}/${name}`, 'utf8'))).toStrictEqual([])
  })
})
