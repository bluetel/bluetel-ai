import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { WorkflowRowReadouts } from './workflow-listing'
import { WorkflowRow } from './workflow-row'

/**
 * The row is presentational, so what is asserted here is what the markup itself claims: that every
 * FR-012 field reaches the page, that the run is reachable by link, that state is reported through
 * the state chip rather than by a colour chosen here, and that the type split holds.
 */

const row: WorkflowRowReadouts = {
  id: '0199a1f4-0000-7000-8000-0000000000ab',
  runId: '0199a1f4…',
  state: 'running',
  stateReadout: 'running 04:21',
  type: 'delegated',
  startedByLabel: 'initiated by',
  startedBy: 'Ada Lovelace',
  owner: 'Ada Lovelace',
  workspace: 'Acme platform',
  ticket: 'ABC-12',
  model: 'claude-sonnet-4-5',
  executionProfile: 'API maintenance',
  startedAt: '2026-08-05 09:00',
  duration: '4:21',
  turns: '14',
  spend: '3.1400',
  outcome: '—',
}

describe('WorkflowRow', () => {
  it('shows every field FR-012 requires of a row', () => {
    const markup = renderToStaticMarkup(<WorkflowRow row={row} />)

    for (const value of [
      'Ada Lovelace',
      'delegated',
      'Acme platform',
      'ABC-12',
      'claude-sonnet-4-5',
      'API maintenance',
      '2026-08-05 09:00',
      '4:21',
      '14',
      '3.1400',
    ]) {
      expect(markup).toContain(value)
    }
  })

  it('links to the run, with the whole id available rather than only the abbreviation', () => {
    const markup = renderToStaticMarkup(<WorkflowRow row={row} />)

    expect(markup).toContain('href="/workflows/0199a1f4-0000-7000-8000-0000000000ab"')
    expect(markup).toContain('title="0199a1f4-0000-7000-8000-0000000000ab"')
  })

  it('reports state through the chip, whose colour derives from the state (FR-025, FR-030)', () => {
    const markup = renderToStaticMarkup(<WorkflowRow row={row} />)

    expect(markup).toContain('data-state="running"')
    expect(markup).toContain('running 04:21')
    // Amber is the mapping's answer for `running`. The row never names a colour itself.
    expect(markup).toContain('text-amber')
  })

  it('takes its colour from the state alone — a settled run is not amber', () => {
    const markup = renderToStaticMarkup(
      <WorkflowRow row={{ ...row, state: 'succeeded', stateReadout: 'succeeded' }} />,
    )

    expect(markup).toContain('text-verdigris')
    expect(markup).not.toContain('text-amber')
  })

  it('sets every value in data-mono under a label-mono caption, and writes no prose (FR-026)', () => {
    const markup = renderToStaticMarkup(<WorkflowRow row={row} />)

    // Twelve readouts plus the run id in the header. `type-body` appears only as `CardBody`'s own
    // container class; a row contributes no paragraph of its own.
    expect(markup.match(/type-data-mono/g)).toHaveLength(13)
    expect(markup.match(/type-label-mono text-graphite/g)).toHaveLength(12)
    expect(markup).not.toContain('<p')
  })

  it('writes no literal colour, size or radius (SC-015)', () => {
    const markup = renderToStaticMarkup(<WorkflowRow row={row} />)

    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(markup).not.toMatch(/style="[^"]*\d+(px|rem)/)
  })
})
