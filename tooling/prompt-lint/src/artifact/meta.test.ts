import { describe, expect, it } from 'vitest'

import { collectDuplicates, metaGet, metaGetAll, parseSkillMeta } from './meta'

describe('parseSkillMeta', () => {
  it('reads key=value pairs with their 1-indexed lines', () => {
    const meta = parseSkillMeta('name=review\nversion=1.0.2\n')
    expect(meta.format).toBe('skill-meta')
    expect(meta.entries).toEqual([
      { key: 'name', value: 'review', line: 1 },
      { key: 'version', value: '1.0.2', line: 2 },
    ])
  })

  it('keeps a value containing `=` and `|` intact — next_step is pipe-separated', () => {
    const meta = parseSkillMeta('next_step=/x --flag=1|because|when\n')
    expect(metaGet(meta, 'next_step')).toBe('/x --flag=1|because|when')
  })

  it('keeps every value of a repeatable key, in order', () => {
    const meta = parseSkillMeta('next_step=a|b\nnext_step=c|d\n')
    expect(metaGetAll(meta, 'next_step')).toEqual(['a|b', 'c|d'])
    expect(meta.duplicates).toEqual([])
  })

  it('records a repeated non-repeatable key as a duplicate with every line', () => {
    const meta = parseSkillMeta('name=a\nversion=1.0.0\nname=b\n')
    expect(meta.duplicates).toEqual([{ key: 'name', lines: [1, 3] }])
  })

  it('returns the first value for a duplicated key, as skills.sh meta_get does', () => {
    // The installer reads the first match, so a reader who sees the second value and the
    // installer disagree about the same file. That is the defect worth being exact about.
    expect(metaGet(parseSkillMeta('name=first\nname=second\n'), 'name')).toBe('first')
  })

  it('ignores comments and blank lines', () => {
    const meta = parseSkillMeta('# a comment\n\nname=x\n')
    expect(meta.entries).toHaveLength(1)
    expect(meta.strayLines).toEqual([])
  })

  it('records a line with no `=` as stray rather than dropping it', () => {
    const meta = parseSkillMeta('name=x\nthis is a wrapped description\n')
    expect(meta.strayLines).toEqual([2])
  })

  it('accepts an empty value — required-field is a rule, not a parse error', () => {
    const meta = parseSkillMeta('requires=\n')
    expect(meta.entries).toEqual([{ key: 'requires', value: '', line: 1 }])
    expect(meta.strayLines).toEqual([])
  })
})

describe('collectDuplicates', () => {
  it('sorts by key so two runs report identically', () => {
    const duplicates = collectDuplicates([
      { key: 'version', value: '1', line: 1 },
      { key: 'name', value: 'a', line: 2 },
      { key: 'version', value: '2', line: 3 },
      { key: 'name', value: 'b', line: 4 },
    ])
    expect(duplicates.map((entry) => entry.key)).toEqual(['name', 'version'])
  })
})
