import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { FleetPanel } from './fleet-panel'

/**
 * The panel holds two queries and a router push, so it cannot be rendered without a tRPC provider
 * and a query client, and there is no testing library in this app to drive it with. Its parts carry
 * the behavioural assertions: `spend-grouping` covers every conversion between the URL and the
 * procedure's input, `spend-readouts` covers the shaping, `spend-summary-card` covers what the card
 * puts on screen, and the reused `workflow-filters` / `workflow-list` suites cover the list.
 *
 * What is asserted here is what only the wiring can get wrong: that it composes the existing fleet
 * list rather than re-implementing it, and that it performs no arithmetic across the two queries.
 * The second is a source-level property because it is the absence of code — a panel that summed the
 * loaded rows and compared them against the scoped total would invent a discrepancy out of
 * pagination and imply a figure neither query returned.
 */

const source = readFileSync(new URL('./fleet-panel.tsx', import.meta.url), 'utf8')

describe('FleetPanel', () => {
  it('is a component the page can mount, taking the parsed filters and grouping', () => {
    expect(typeof FleetPanel).toBe('function')
    expect(FleetPanel).toHaveLength(1)
  })

  it('composes the existing filter bar, list and shaping rather than its own', () => {
    expect(source).toContain("from '@sisyphus-admin/components/workflows'")
    for (const reused of [
      'WorkflowFilterBar',
      'WorkflowList',
      'toWorkflowRowReadouts',
      'toListInput',
      'toSearchParams',
      'invalidIdFilters',
    ]) {
      expect(source).toContain(reused)
    }
  })

  it('reads both figures from scoped procedures and neither from the other', () => {
    expect(source).toContain('api.workflow.list.useInfiniteQuery')
    expect(source).toContain('api.workflow.spendSummary.useQuery')
    // No cross-query arithmetic: the rows are one page and the summary is the whole scope.
    expect(source).not.toMatch(/rows\s*\.\s*reduce/)
    expect(source).not.toMatch(/\.reduce\([^)]*spend/i)
  })

  it('never asks for the individual grouping', () => {
    // The grouping only ever comes from `./spend-grouping`, which cannot produce `user`.
    expect(source).not.toContain("'user'")
    expect(source).toContain('toSpendSummaryInput(grouping)')
  })

  it('keeps one clock for the page, so every duration on screen agrees', () => {
    expect(source).toContain('useNow')
    expect(source).not.toContain('Date.now()')
  })
})
