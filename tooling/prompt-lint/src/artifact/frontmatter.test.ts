import { describe, expect, it } from 'vitest'

import { parseFrontmatter } from './frontmatter'

describe('parseFrontmatter', () => {
  it('reads the flat key: value block and reports where the body starts', () => {
    const { meta, bodyStartLine } = parseFrontmatter(
      "---\nname: review\ndescription: 'Does a thing.'\n---\n\nbody\n",
    )
    expect(meta?.format).toBe('frontmatter')
    expect(meta?.entries).toEqual([
      { key: 'name', value: 'review', line: 2 },
      { key: 'description', value: 'Does a thing.', line: 3 },
    ])
    expect(bodyStartLine).toBe(4)
  })

  it('strips one layer of matching quotes only', () => {
    const { meta } = parseFrontmatter('---\na: "x"\nb: \'y\'\nc: "z\n---\n')
    expect(meta?.entries.map((entry) => entry.value)).toEqual(['x', 'y', '"z'])
  })

  it('keeps a colon inside a value — every description has a `Use when:` clause', () => {
    const { meta } = parseFrontmatter("---\ndescription: 'Does x. Use when: you need x.'\n---\n")
    expect(meta?.entries[0].value).toBe('Does x. Use when: you need x.')
  })

  it('accepts a hyphenated key — argument-hint is one', () => {
    const { meta } = parseFrontmatter("---\nargument-hint: '[mode]'\n---\n")
    expect(meta?.entries[0].key).toBe('argument-hint')
  })

  it('returns null when the file has no frontmatter at all', () => {
    expect(parseFrontmatter('# Just markdown\n').meta).toBeNull()
  })

  it('returns null for an unterminated block rather than treating prose as metadata', () => {
    // One missing `---` must not turn every following line into a stray-line finding.
    expect(parseFrontmatter('---\nname: x\n\nbody with no closing delimiter\n').meta).toBeNull()
  })

  it('records a value shape it cannot represent as stray rather than guessing', () => {
    const { meta } = parseFrontmatter('---\nname: x\nnested:\n  a: 1\n---\n')
    expect(meta?.strayLines).toEqual([3, 4])
  })

  it('records a repeated key as a duplicate', () => {
    const { meta } = parseFrontmatter('---\nname: a\nname: b\n---\n')
    expect(meta?.duplicates).toEqual([{ key: 'name', lines: [2, 3] }])
  })
})
