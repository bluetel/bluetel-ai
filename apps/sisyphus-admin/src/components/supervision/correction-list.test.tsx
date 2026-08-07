import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { CorrectionReadout } from './correction-list'
import { CorrectionList } from './correction-list'

/**
 * A correction that could not be delivered has to be **seen**. That is the whole requirement, and
 * the way it is broken is by a list that renders only the successes, which looks tidier and is a
 * silent drop.
 */

const delivered: CorrectionReadout = {
  id: 'c1',
  sequence: 1,
  body: 'prefer the existing helper',
  outcome: 'delivered',
  failureReason: null,
  submittedAt: '2026-08-05 09:00:00',
}

const failed: CorrectionReadout = {
  id: 'c2',
  sequence: 2,
  body: 'this one did not land',
  outcome: 'failed',
  failureReason: 'the agent process is not accepting input',
  submittedAt: '2026-08-05 09:01:00',
}

describe('CorrectionList', () => {
  it('says so plainly when there are none', () => {
    expect(renderToStaticMarkup(<CorrectionList corrections={[]} />)).toContain('no corrections')
  })

  it('shows the delivery outcome of every correction, failures included', () => {
    const markup = renderToStaticMarkup(<CorrectionList corrections={[delivered, failed]} />)

    expect(markup).toContain('DELIVERED')
    expect(markup).toContain('FAILED')
    expect(markup).toContain('this one did not land')
  })

  it('shows the reason a delivery failed, verbatim', () => {
    const markup = renderToStaticMarkup(<CorrectionList corrections={[failed]} />)

    expect(markup).toContain('not delivered')
    expect(markup).toContain('the agent process is not accepting input')
  })

  it('adds no reason line to a correction that landed', () => {
    const markup = renderToStaticMarkup(<CorrectionList corrections={[delivered]} />)

    expect(markup).not.toContain('not delivered')
  })

  it('keeps submission order, which is delivery order', () => {
    const markup = renderToStaticMarkup(<CorrectionList corrections={[delivered, failed]} />)

    expect(markup.indexOf('prefer the existing helper')).toBeLessThan(
      markup.indexOf('this one did not land'),
    )
  })

  it('renders a pending correction as pending rather than as delivered', () => {
    const markup = renderToStaticMarkup(
      <CorrectionList corrections={[{ ...delivered, outcome: 'pending' }]} />,
    )

    expect(markup).toContain('PENDING')
    expect(markup).not.toContain('DELIVERED')
  })

  it('writes no literal colour, size or radius (SC-015)', () => {
    const markup = renderToStaticMarkup(<CorrectionList corrections={[delivered, failed]} />)

    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(markup).not.toMatch(/style="/)
    expect(markup).not.toMatch(/\b\d+(px|rem)\b/)
  })
})
