import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { TimelineReadouts } from './workflow-detail-readouts'
import { WorkflowTimeline } from './workflow-timeline'

const entries: readonly TimelineReadouts[] = [
  { id: 'a', event: 'provisioned', actor: 'platform', at: '2026-08-05 09:00' },
  { id: 'b', event: 'corrected', actor: 'Ada Lovelace', at: '2026-08-05 09:02' },
]

describe('WorkflowTimeline', () => {
  it('renders each event with its actor and its stamp', () => {
    const markup = renderToStaticMarkup(<WorkflowTimeline entries={entries} />)

    expect(markup).toContain('provisioned')
    expect(markup).toContain('Ada Lovelace')
    expect(markup).toContain('2026-08-05 09:02')
    expect(markup).toContain('events 2')
  })

  it('keeps the order it was given — a timeline the panel re-sorted is not the record', () => {
    const markup = renderToStaticMarkup(<WorkflowTimeline entries={entries} />)

    expect(markup.indexOf('provisioned')).toBeLessThan(markup.indexOf('corrected'))
  })

  it('says it is reading rather than showing an empty timeline', () => {
    const markup = renderToStaticMarkup(<WorkflowTimeline entries={[]} loading />)

    expect(markup).toContain('reading')
    expect(markup).toContain('data-note="loading"')
    expect(markup).toContain('reading the lifecycle record')
    expect(markup).not.toContain('no lifecycle events recorded yet')
  })

  it('says nothing has happened once the read has finished', () => {
    const markup = renderToStaticMarkup(<WorkflowTimeline entries={[]} />)

    expect(markup).toContain('no lifecycle events recorded yet')
  })

  it('is all machine readout and no prose — nothing on this card was written by a person', () => {
    const markup = renderToStaticMarkup(<WorkflowTimeline entries={entries} />)

    expect(markup).toContain('type-data-mono')
    expect(markup).not.toContain('measure-prose')
  })

  it('writes no literal colour, size or radius (SC-015)', () => {
    const markup = renderToStaticMarkup(<WorkflowTimeline entries={entries} />)

    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(markup).not.toMatch(/style="[^"]*\d+(px|rem)/)
  })
})
