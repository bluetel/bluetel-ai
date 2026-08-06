import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { IterationRecord } from './iteration-readouts'
import { toIterationTimelineReadouts } from './iteration-readouts'
import { IterationTimelineCard } from './iteration-timeline-card'

/**
 * The iteration card (T127, FR-061, FR-062, SC-015).
 */

const iteration = (
  ordinal: number,
  verdict: IterationRecord['verdict'],
  ...summaries: readonly string[]
): IterationRecord => ({
  id: `it-${String(ordinal)}`,
  ordinal,
  verdict,
  startedAt: null,
  endedAt: null,
  findings: summaries.map((summary) => ({ severity: 'blocker' as const, summary })),
})

const exhausted = toIterationTimelineReadouts([
  iteration(1, 'fail', 'The retry loop has no ceiling.'),
  iteration(2, 'fail', 'The new timeout is not covered by a test.'),
  iteration(3, 'fail', 'The error is swallowed.'),
])

const passed = toIterationTimelineReadouts([iteration(1, 'fail', 'a'), iteration(2, 'pass')])

describe('IterationTimelineCard', () => {
  it('shows how much of the bound was used', () => {
    const markup = renderToStaticMarkup(<IterationTimelineCard timeline={exhausted} />)

    expect(markup).toContain('3 of 3')
    expect(markup).toContain('1 of 3')
  })

  it('puts what is still wrong before the history that produced it', () => {
    const markup = renderToStaticMarkup(<IterationTimelineCard timeline={exhausted} />)

    // `>iteration<` is the per-pass readout label; `iterations` in the header would match first.
    expect(markup.indexOf('>unresolved<')).toBeLessThan(markup.indexOf('>iteration<'))
    expect(markup).toContain('The retry loop has no ceiling.')
  })

  it('says a fourth iteration was not attempted, rather than leaving it to be inferred', () => {
    const markup = renderToStaticMarkup(<IterationTimelineCard timeline={exhausted} />)

    expect(markup).toContain('A fourth iteration was not attempted')
    expect(markup).toContain('role="status"')
  })

  it('says nothing of the kind for a run that passed', () => {
    const markup = renderToStaticMarkup(<IterationTimelineCard timeline={passed} />)

    expect(markup).not.toContain('A fourth iteration was not attempted')
    expect(markup).toContain('Review passed on iteration 2 of 3.')
    expect(markup).not.toContain('unresolved')
  })

  it('says it is reading rather than showing an empty card', () => {
    const markup = renderToStaticMarkup(
      <IterationTimelineCard timeline={toIterationTimelineReadouts([])} loading />,
    )

    expect(markup).toContain('reading')
    expect(markup).not.toContain('no development iterations recorded')
  })

  it('says nothing was recorded once the read has finished', () => {
    const markup = renderToStaticMarkup(
      <IterationTimelineCard timeline={toIterationTimelineReadouts([])} />,
    )

    expect(markup).toContain('no development iterations recorded')
  })

  it('offers no control — a fourth iteration is refused by the database', () => {
    const markup = renderToStaticMarkup(<IterationTimelineCard timeline={exhausted} />)

    expect(markup).not.toContain('<button')
    expect(markup).not.toContain('<form')
    expect(markup).not.toContain('role="button"')
    expect(markup).not.toContain('<a ')
  })

  it('uses no colour of its own — colour on this panel means machine state', () => {
    const markup = renderToStaticMarkup(<IterationTimelineCard timeline={exhausted} />)

    expect(markup).toContain('data-state="idle"')
  })

  it('writes no literal colour, size or radius (SC-015)', () => {
    const markup = renderToStaticMarkup(<IterationTimelineCard timeline={exhausted} />)

    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u)
    expect(markup).not.toMatch(/style="[^"]*\d+(?:px|rem)/u)
  })
})
