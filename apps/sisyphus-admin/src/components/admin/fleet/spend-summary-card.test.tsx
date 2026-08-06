import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { SpendReadouts } from './spend-readouts'
import { SpendSummaryCard } from './spend-summary-card'

/**
 * The card is presentational, so what is asserted is what the markup itself claims: that the scoped
 * totals reach the page, that the grouping toggles offer three options and never a person (FR-156),
 * that money is set in `data-mono` under a `label-mono` caption (FR-026), and that nothing here
 * writes a literal colour or size (SC-015).
 */

const readouts: SpendReadouts = {
  groups: [
    {
      key: '0199a1f4-0000-7000-8000-0000000000ab',
      name: 'API maintenance',
      workflows: '3',
      spend: '75.0000',
      turns: '42',
      share: 75,
    },
    {
      key: 'unattributed',
      name: 'unattributed',
      workflows: '1',
      spend: '25.0000',
      turns: '9',
      share: 25,
    },
  ],
  workflows: '4',
  spend: '100.0000',
  turns: '51',
}

const noop = (): void => undefined

const markupFor = (over: Partial<Parameters<typeof SpendSummaryCard>[0]> = {}): string =>
  renderToStaticMarkup(
    <SpendSummaryCard readouts={readouts} grouping="profile" onGroupingChange={noop} {...over} />,
  )

describe('SpendSummaryCard', () => {
  it('shows the scoped totals and every group’s figures', () => {
    const markup = markupFor()

    for (const value of ['100.0000', '75.0000', '25.0000', 'API maintenance', 'unattributed']) {
      expect(markup).toContain(value)
    }
  })

  it('offers the three collective groupings and never an individual one (FR-156)', () => {
    const markup = markupFor()

    expect(markup).toContain('Client')
    expect(markup).toContain('Workspace')
    expect(markup).toContain('Execution profile')
    // No control on this screen produces a per-person breakdown.
    expect(markup).not.toContain('>User<')
  })

  it('marks the current grouping as pressed rather than by colour alone', () => {
    expect(markupFor({ grouping: 'client' })).toContain('aria-pressed="true"')
  })

  it('says what the total is a total of, so a scoped figure is not read as the platform’s (FR-190)', () => {
    expect(markupFor()).toContain('a run outside your scope is not in it')
  })

  it('distinguishes an empty scope from a read still in flight', () => {
    const empty: SpendReadouts = { groups: [], workflows: '0', spend: '0.0000', turns: '0' }

    expect(markupFor({ readouts: empty })).toContain('no spend recorded in your scope')
    expect(markupFor({ readouts: empty, loading: true })).toContain('reading')
  })

  it('renders a refusal with a code and a next action rather than a dead end (FR-031)', () => {
    const markup = markupFor({
      error: { code: 'E_TARGET_NOT_FOUND', action: 'Reload the list.' },
    })

    expect(markup).toContain('E_TARGET_NOT_FOUND')
    expect(markup).toContain('Reload the list.')
  })

  it('reports the share through the meter, which is signal rather than a state colour (FR-025)', () => {
    const markup = markupFor()

    expect(markup).toContain('role="meter"')
    expect(markup).toContain('bg-signal')
    // A quantity is not a machine state: no state colour appears on a spend bar.
    expect(markup).not.toContain('bg-amber')
  })

  it('sets every figure in data-mono under a label-mono caption (FR-026)', () => {
    const markup = markupFor()

    // Three summary readouts plus four per group, over two groups.
    expect(markup.match(/type-data-mono/g)).toHaveLength(11)
    // The same eleven captions, plus the `group by` label and the idle state chip's own readout.
    expect(markup.match(/type-label-mono text-graphite/g)).toHaveLength(13)
  })

  it('writes no literal colour, size or radius (SC-015)', () => {
    const markup = markupFor()

    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(markup).not.toMatch(/style="[^"]*\d+(px|rem)/)
  })
})
