import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { LogViewerSlot } from './log-viewer-slot'

/**
 * The slot's whole job is to make an absence legible. The assertion that matters is that the empty
 * state says *the component is missing*, not *the run has no output* — those are very different
 * claims to make about a run, and one of them is a lie.
 */

const WORKFLOW_ID = '0199a1f4-0000-7000-8000-0000000000ab'

describe('LogViewerSlot', () => {
  it('says the viewer is not mounted, rather than leaving a blank region', () => {
    const markup = renderToStaticMarkup(<LogViewerSlot workflowId={WORKFLOW_ID} />)

    expect(markup).toContain('not mounted')
    expect(markup).toContain('The log viewer is not mounted on this page yet')
  })

  it('never claims the run produced no output', () => {
    const markup = renderToStaticMarkup(<LogViewerSlot workflowId={WORKFLOW_ID} />)

    expect(markup).toContain('a missing component rather than a run with no output')
    expect(markup).not.toContain('no log')
  })

  it('names the run whose output belongs here', () => {
    const markup = renderToStaticMarkup(<LogViewerSlot workflowId={WORKFLOW_ID} />)

    expect(markup).toContain(WORKFLOW_ID)
  })

  it('gives the viewer the card and the chip when one is passed, and stops explaining itself', () => {
    const markup = renderToStaticMarkup(
      <LogViewerSlot workflowId={WORKFLOW_ID}>
        <pre>a log line</pre>
      </LogViewerSlot>,
    )

    expect(markup).toContain('a log line')
    expect(markup).toContain('mounted')
    expect(markup).not.toContain('not mounted')
  })

  it('writes no literal colour, size or radius (SC-015)', () => {
    const markup = renderToStaticMarkup(<LogViewerSlot workflowId={WORKFLOW_ID} />)

    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(markup).not.toMatch(/style="[^"]*\d+(px|rem)/)
  })
})
