import { describe, expect, it } from 'vitest'

import { inRanges, parseMarkdown } from './markdown'

describe('parseMarkdown', () => {
  it('indexes lines and ATX headings with their levels', () => {
    const view = parseMarkdown('# Title\n\ntext\n\n### Deep\n')
    expect(view.lines).toHaveLength(6)
    expect(view.headings).toEqual([
      { line: 0, level: 1, text: 'Title' },
      { line: 4, level: 3, text: 'Deep' },
    ])
  })

  it('does not treat a `#` inside a fenced block as a heading', () => {
    const view = parseMarkdown('# Real\n\n```sh\n# a shell comment\n```\n')
    expect(view.headings).toEqual([{ line: 0, level: 1, text: 'Real' }])
    expect(view.fenced).toEqual([{ start: 2, end: 4 }])
  })

  it('closes a fence only on a marker at least as long as the opener', () => {
    const view = parseMarkdown('````\n```\nstill inside\n````\nout\n')
    expect(view.fenced).toEqual([{ start: 0, end: 3 }])
    expect(inRanges(view.fenced, 2)).toBe(true)
    expect(inRanges(view.fenced, 4)).toBe(false)
  })

  it('runs an unclosed fence to the end of the file rather than ignoring it', () => {
    // The trailing newline makes a final empty line, so the last index is 3 — the fence
    // swallows it, which is the safe direction: content inside an unterminated fence
    // must not be evaluated as prose.
    const view = parseMarkdown('text\n```\nnever closed\n')
    expect(view.fenced).toEqual([{ start: 1, end: 3 }])
  })

  it('spans a multi-line HTML comment, which is how the constitution quotes placeholders', () => {
    const view = parseMarkdown('before\n<!--\n[BRACKETED_TOKEN]\n-->\nafter\n')
    expect(view.htmlComments).toEqual([{ start: 1, end: 3 }])
    expect(inRanges(view.htmlComments, 2)).toBe(true)
  })

  it('ends a single-line comment at the marker, not at the end of the line', () => {
    const view = parseMarkdown('<!-- hidden --> visible/path.md\n')
    const token = view.pathTokens.find((candidate) => candidate.raw === 'visible/path.md')
    expect(token?.inHtmlComment).toBe(false)
  })

  it('matches a backtick run with a run of the same length', () => {
    const view = parseMarkdown('a `code` and ``a ` b`` end\n')
    // The second span is opened and closed by a two-backtick run, so it covers both
    // characters of the closing run: columns 13–21 inclusive.
    expect(view.codeSpans.get(0)).toEqual([
      { start: 2, end: 7 },
      { start: 13, end: 21 },
    ])
  })

  it('collects inline link targets with their text', () => {
    const view = parseMarkdown('see [the plan](./plan.md) and [x](a/b.md "t")\n')
    expect(view.links).toEqual([
      { line: 0, text: 'the plan', target: './plan.md' },
      { line: 0, text: 'x', target: 'a/b.md' },
    ])
  })

  describe('path tokens', () => {
    it('flags a token inside a code span', () => {
      const view = parseMarkdown('run `tooling/skills/lib/skills.sh` now\n')
      const token = view.pathTokens.find((c) => c.raw === 'tooling/skills/lib/skills.sh')
      expect(token).toMatchObject({ inCodeSpan: true, inFence: false, literal: true })
    })

    it('flags a token inside a fence', () => {
      const view = parseMarkdown('```\ncat a/b.md\n```\n')
      expect(view.pathTokens.find((c) => c.raw === 'a/b.md')?.inFence).toBe(true)
    })

    it('emits bare filenames so the rule can decide to ignore them', () => {
      const view = parseMarkdown('reads spec.md then plan.md\n')
      expect(view.pathTokens.map((c) => c.raw)).toEqual(['spec.md', 'plan.md'])
    })

    it('marks variable-bearing tokens as not literal', () => {
      const view = parseMarkdown('at $FEATURE_DIR/spec.md and {dir}/x.md and <root>/y.md\n')
      const byRaw = new Map(view.pathTokens.map((c) => [c.raw, c.literal]))
      expect(byRaw.get('$FEATURE_DIR/spec.md')).toBe(false)
      expect([...byRaw.entries()].filter(([, literal]) => literal)).toEqual([])
    })

    it('marks a SCREAMING_SNAKE segment as not literal — that is Spec Kit variable syntax', () => {
      const view = parseMarkdown('at SPECIFY_FEATURE_DIRECTORY/spec.md\n')
      expect(view.pathTokens[0]).toMatchObject({
        raw: 'SPECIFY_FEATURE_DIRECTORY/spec.md',
        literal: false,
      })
    })

    it('strips trailing sentence punctuation from a token', () => {
      const view = parseMarkdown('see `a/b.md`.\n')
      expect(view.pathTokens.map((c) => c.raw)).toContain('a/b.md')
    })

    it('reports each token at the column it occupies, for FR-007 line and column', () => {
      const view = parseMarkdown('xx a/b.md\n')
      expect(view.pathTokens[0]).toMatchObject({ line: 0, column: 3 })
    })

    it('is deterministic: tokens come back sorted by position', () => {
      const view = parseMarkdown('z/a.md [t](a/b.md)\n')
      const positions = view.pathTokens.map((c) => c.column)
      expect(positions).toEqual([...positions].sort((a, b) => a - b))
    })
  })
})
