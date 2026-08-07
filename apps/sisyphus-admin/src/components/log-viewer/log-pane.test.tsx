import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { LogLine } from './log-line'
import { LogPane } from './log-pane'

const withLines = (markup: React.ReactNode) => renderToStaticMarkup(<>{markup}</>)

describe('LogPane', () => {
  it('is the log-viewer component DESIGN.md declares', () => {
    const markup = withLines(
      <LogPane status="live" total={1}>
        <LogLine sequence={1} state="read" text="hello" />
      </LogPane>,
    )

    expect(markup).toContain('bg-paper-2')
    expect(markup).toContain('text-ink')
    expect(markup).toContain('rounded-md')
    expect(markup).toContain('p-close')
  })

  it('always says whether the stream is live, so silence is never ambiguous', () => {
    // Spike S3's finding was that a broken transport is silent, and a silent transport is
    // indistinguishable from a quiet agent unless the pane says which it is.
    expect(withLines(<LogPane status="live" total={0} />)).toContain('live')
    expect(withLines(<LogPane status="interrupted" total={0} />)).toContain('reconnecting')
    expect(withLines(<LogPane status="complete" total={0} />)).toContain('complete')
    expect(withLines(<LogPane status="connecting" total={0} />)).toContain('connecting')
  })

  it('distinguishes a run that finished from one that stopped being visible', () => {
    expect(withLines(<LogPane status="complete" total={0} />)).toContain('complete')
    expect(withLines(<LogPane status="gone" total={0} />)).toContain('ended')
  })

  it('names a hole in the log rather than leaving it to be read as a quiet agent (FR-046)', () => {
    const markup = withLines(<LogPane status="live" total={2} missing={[2, 3]} />)

    expect(markup).toContain('Waiting on 2 segments')
  })

  it('says nothing about gaps when the log is continuous', () => {
    expect(withLines(<LogPane status="live" total={2} />)).not.toContain('Waiting on')
  })

  it('agrees on singular and plural, which a log with one gap will show', () => {
    expect(withLines(<LogPane status="live" total={2} missing={[2]} />)).toContain(
      'Waiting on 1 segment not yet received',
    )
  })

  it('says a run has produced nothing rather than rendering an empty box', () => {
    expect(withLines(<LogPane status="live" total={0} />)).toContain('No output yet')
  })

  it('names the region for assistive technology without announcing every line', () => {
    const markup = withLines(<LogPane status="live" total={0} />)

    expect(markup).toContain('aria-label="Run output"')
    expect(markup).not.toContain('aria-live')
  })

  it('uses no literal colour, size or spacing (SC-015)', () => {
    const markup = withLines(
      <LogPane status="live" total={1} missing={[2]}>
        <LogLine sequence={1} state="read" text="hello" />
      </LogPane>,
    )

    expect(markup).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(markup).not.toMatch(/\d+(px|rem)\b/)
  })
})
