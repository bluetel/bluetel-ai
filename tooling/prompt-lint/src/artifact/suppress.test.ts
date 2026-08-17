import { describe, expect, it } from 'vitest'

import { parseSuppressions, suppresses } from './suppress'

describe('parseSuppressions', () => {
  it('parses the documented markdown form, scoped to the next line', () => {
    const [suppression] = parseSuppressions(
      '<!-- prompt-lint-disable-next-line refs/dangling-path — created by step 3 at runtime -->\nSee `x/y.md`.\n',
      'markdown',
    )
    expect(suppression).toEqual({
      rule: 'refs/dangling-path',
      markerLine: 1,
      targetLine: 2,
      reason: 'created by step 3 at runtime',
      used: false,
    })
  })

  it('parses the `#` form for skill.meta', () => {
    const [suppression] = parseSuppressions(
      '# prompt-lint-disable-next-line meta/stray-line — the installer writes this\nname=x\n',
      'skill-meta',
    )
    expect(suppression).toMatchObject({ rule: 'meta/stray-line', targetLine: 2 })
  })

  it('records an empty reason rather than skipping the marker — that is FR-009’s finding', () => {
    const [suppression] = parseSuppressions(
      '<!-- prompt-lint-disable-next-line refs/dangling-path -->\ntext\n',
      'markdown',
    )
    expect(suppression.reason).toBe('')
  })

  it('accepts a hyphen or colon separator, so a real reason is never read as none', () => {
    const reasons = [
      '<!-- prompt-lint-disable-next-line a/b - hyphen reason -->',
      '<!-- prompt-lint-disable-next-line a/b -- double hyphen reason -->',
      '<!-- prompt-lint-disable-next-line a/b : colon reason -->',
      '<!-- prompt-lint-disable-next-line a/b – en dash reason -->',
    ].map((line) => parseSuppressions(`${line}\ntext\n`, 'markdown')[0].reason)
    expect(reasons).toEqual([
      'hyphen reason',
      'double hyphen reason',
      'colon reason',
      'en dash reason',
    ])
  })

  it('reads a reason that spans the comment across lines', () => {
    const [suppression] = parseSuppressions(
      '<!-- prompt-lint-disable-next-line a/b — a long reason -->\ntext\n',
      'markdown',
    )
    expect(suppression.reason).toBe('a long reason')
  })

  it('finds every marker in a file', () => {
    const content =
      '<!-- prompt-lint-disable-next-line a/b — one -->\nx\n<!-- prompt-lint-disable-next-line c/d — two -->\ny\n'
    expect(parseSuppressions(content, 'markdown').map((s) => s.markerLine)).toEqual([1, 3])
  })

  it('ignores a comment that is not the directive', () => {
    expect(parseSuppressions('<!-- just a note -->\nx\n', 'markdown')).toEqual([])
  })

  it('does not read the markdown form out of a skill.meta file, or the reverse', () => {
    const markdownForm = '<!-- prompt-lint-disable-next-line a/b — r -->\nx\n'
    expect(parseSuppressions(markdownForm, 'skill-meta')).toEqual([])
    expect(parseSuppressions('# prompt-lint-disable-next-line a/b — r\nx\n', 'markdown')).toEqual(
      [],
    )
  })
})

describe('suppresses', () => {
  const suppression = {
    rule: 'a/b',
    markerLine: 1,
    targetLine: 2,
    reason: 'r',
    used: false,
  }

  it('matches only its own rule on only its own line', () => {
    expect(suppresses(suppression, 'a/b', 2)).toBe(true)
    expect(suppresses(suppression, 'a/b', 3)).toBe(false)
    expect(suppresses(suppression, 'c/d', 2)).toBe(false)
  })
})
