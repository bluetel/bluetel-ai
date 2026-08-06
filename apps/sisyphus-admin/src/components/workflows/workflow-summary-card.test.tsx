import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { WorkflowDetailReadouts } from './workflow-detail-readouts'
import { WorkflowSummaryCard } from './workflow-summary-card'

const detail: WorkflowDetailReadouts = {
  id: '0199a1f4-0000-7000-8000-0000000000ab',
  runId: '0199a1f4…',
  state: 'running',
  stateReadout: 'running 10:00',
  type: 'delegated',
  startedByLabel: 'initiated by',
  startedBy: 'Ada Lovelace',
  owner: 'Ada Lovelace',
  workspace: 'Acme platform',
  ticket: 'ABC-12',
  model: 'claude-sonnet-4-5',
  instanceType: 'c7g.2xlarge',
  purchaseMode: 'spot',
  executionProfile: 'API maintenance',
  resultBranch: 'sisyphus/abc-12',
  startedAt: '2026-08-05 09:00',
  lastMovedAt: '2026-08-05 09:04',
  duration: '10:00',
  turns: { used: '14', cap: '40', meter: { value: 14, max: 40 } },
  spend: { used: '3.1400', cap: '10.0000', meter: { value: 3.14, max: 10 } },
  outcome: '—',
  outcomeReason: '—',
  reviewerSummary: null,
  needsReassignment: false,
  promptTruncated: false,
}

describe('WorkflowSummaryCard', () => {
  it('shows the whole launch configuration', () => {
    const markup = renderToStaticMarkup(<WorkflowSummaryCard detail={detail} />)

    for (const value of [
      'Ada Lovelace',
      'delegated',
      'Acme platform',
      'ABC-12',
      'API maintenance',
      'claude-sonnet-4-5',
      'c7g.2xlarge',
      'spot',
      'sisyphus/abc-12',
      '2026-08-05 09:00',
      '10:00',
    ]) {
      expect(markup).toContain(value)
    }
  })

  it('reports state through the chip, coloured from the state (FR-025)', () => {
    const markup = renderToStaticMarkup(<WorkflowSummaryCard detail={detail} />)

    expect(markup).toContain('data-state="running"')
    expect(markup).toContain('running 10:00')
  })

  it('meters a cap in signal, never in a state colour', () => {
    const markup = renderToStaticMarkup(<WorkflowSummaryCard detail={detail} />)

    expect(markup).toContain('role="meter"')
    expect(markup).toContain('bg-signal')
    expect(markup).toContain('14 / 40')
    expect(markup).toContain('3.1400 / 10.0000')
  })

  it('says an uncapped run is uncapped, and draws no meter for it', () => {
    const markup = renderToStaticMarkup(
      <WorkflowSummaryCard
        detail={{
          ...detail,
          turns: { used: '14', cap: undefined, meter: undefined },
          spend: { used: '3.1400', cap: undefined, meter: undefined },
        }}
      />,
    )

    expect(markup).toContain('14 (uncapped)')
    expect(markup).not.toContain('role="meter"')
  })

  it('states why a run ended where it did, when that is more than the outcome name', () => {
    const markup = renderToStaticMarkup(
      <WorkflowSummaryCard
        detail={{ ...detail, outcome: 'capped', outcomeReason: 'The spend cap was reached.' }}
      />,
    )

    expect(markup).toContain('why it ended there')
    expect(markup).toContain('The spend cap was reached.')
  })

  it('omits the reason when there is nothing beyond the outcome to say', () => {
    const markup = renderToStaticMarkup(<WorkflowSummaryCard detail={detail} />)

    expect(markup).not.toContain('why it ended there')
  })

  it('says so when the owner was deactivated (FR-176)', () => {
    const markup = renderToStaticMarkup(
      <WorkflowSummaryCard detail={{ ...detail, needsReassignment: true }} />,
    )

    expect(markup).toContain('owner has been deactivated')
  })

  it('says so when the prompt was truncated (FR-163)', () => {
    const markup = renderToStaticMarkup(
      <WorkflowSummaryCard detail={{ ...detail, promptTruncated: true }} />,
    )

    expect(markup).toContain('truncated oldest-comment-first')
  })

  it('writes no literal colour, size or radius outside the meter’s computed width (SC-015)', () => {
    const markup = renderToStaticMarkup(<WorkflowSummaryCard detail={detail} />)

    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    // The one inline style in the system is the meter's fill, which is a percentage of its track
    // and therefore a reading rather than a dimension.
    expect(markup).not.toMatch(/style="[^"]*\d+(px|rem)/)
  })
})
