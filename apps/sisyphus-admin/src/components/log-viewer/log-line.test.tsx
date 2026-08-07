import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { LogLine } from './log-line'

describe('LogLine', () => {
  it('sets output in the code token, which is IBM Plex Mono per DESIGN.md', () => {
    const markup = renderToStaticMarkup(<LogLine sequence={1} state="read" text="hello" />)

    expect(markup).toContain('type-code')
    expect(markup).toContain('<code')
  })

  it('renders output as text and never as markup', () => {
    const markup = renderToStaticMarkup(
      <LogLine sequence={1} state="read" text={'<script>alert(1)</script>'} />,
    )

    expect(markup).toContain('&lt;script&gt;')
    expect(markup).not.toContain('<script>')
  })

  it('does not rewrite the stored content, which was sanitised on the instance', () => {
    // A viewer that stripped or escaped further would disagree with the record FR-046 requires be
    // readable afterwards. The only transformation is HTML-escaping for display.
    const markup = renderToStaticMarkup(
      <LogLine sequence={1} state="read" text={'warning: token=[redacted] & "quoted"'} />,
    )

    expect(markup).toContain('warning: token=[redacted]')
    expect(markup).toContain('&amp;')
    expect(markup).toContain('&quot;quoted&quot;')
  })

  it("preserves the agent's own line breaks and indentation", () => {
    const markup = renderToStaticMarkup(<LogLine sequence={1} state="read" text={'a\n  b'} />)

    expect(markup).toContain('whitespace-pre-wrap')
    expect(markup).toContain('a\n  b')
  })

  it('wraps a long token inside the pane rather than scrolling the log sideways', () => {
    const markup = renderToStaticMarkup(<LogLine sequence={1} state="read" text="x" />)

    expect(markup).toContain('break-words')
  })

  it('names retention rather than failure for a segment that is no longer stored', () => {
    const markup = renderToStaticMarkup(<LogLine sequence={4} state="unavailable" />)

    expect(markup).toContain('no longer stored')
    expect(markup).not.toMatch(/error|failed/i)
  })

  it('says why an oversized segment is not shown', () => {
    expect(renderToStaticMarkup(<LogLine sequence={4} state="too-large" />)).toContain('too large')
  })

  it('marks the sequence gutter as decoration, so a screen reader reads output not numbers', () => {
    const markup = renderToStaticMarkup(<LogLine sequence={42} state="read" text="hello" />)

    expect(markup).toContain('aria-hidden="true"')
    expect(markup).toContain('data-sequence="42"')
  })

  it('uses no literal colour, size or spacing (SC-015)', () => {
    const markup = renderToStaticMarkup(<LogLine sequence={1} state="read" text="hello" />)

    expect(markup).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(markup).not.toMatch(/\d+(px|rem)\b/)
  })
})
