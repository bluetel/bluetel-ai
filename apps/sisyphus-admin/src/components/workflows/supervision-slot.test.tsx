import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SupervisionSlot } from './supervision-slot'

/**
 * The supervision slot must not imply a capability the panel does not have. A disabled Pause button
 * says "this exists and is momentarily unavailable"; what is true today is that this panel cannot
 * supervise a run at all, and that is what the empty state has to say.
 */

const WORKFLOW_ID = '0199a1f4-0000-7000-8000-0000000000ab'

describe('SupervisionSlot', () => {
  it('says the controls are not mounted', () => {
    const markup = renderToStaticMarkup(<SupervisionSlot workflowId={WORKFLOW_ID} live />)

    expect(markup).toContain('not mounted')
    expect(markup).toContain('Pause, resume, stop and mid-run correction')
  })

  it('offers no control at all, disabled or otherwise', () => {
    const markup = renderToStaticMarkup(<SupervisionSlot workflowId={WORKFLOW_ID} live />)

    expect(markup).not.toContain('<button')
  })

  it('distinguishes a run there would be something to act on from one there would not', () => {
    const live = renderToStaticMarkup(<SupervisionSlot workflowId={WORKFLOW_ID} live />)
    const settled = renderToStaticMarkup(<SupervisionSlot workflowId={WORKFLOW_ID} live={false} />)

    expect(live).toContain('still in flight')
    expect(settled).toContain('has finished')
  })

  it('gives the controls the card when they are passed, and stops explaining itself', () => {
    const markup = renderToStaticMarkup(
      <SupervisionSlot workflowId={WORKFLOW_ID} live>
        <button type="button">Pause</button>
      </SupervisionSlot>,
    )

    expect(markup).toContain('Pause')
    expect(markup).not.toContain('not mounted')
  })

  it('writes no literal colour, size or radius (SC-015)', () => {
    const markup = renderToStaticMarkup(<SupervisionSlot workflowId={WORKFLOW_ID} live />)

    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(markup).not.toMatch(/style="[^"]*\d+(px|rem)/)
  })
})
