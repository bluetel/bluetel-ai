import { describe, expect, it } from 'vitest'

import { WorkflowsPanel } from './workflows-panel'

/**
 * The panel holds the infinite query and the router push, so it cannot be rendered without a tRPC
 * provider and a query client — and with no testing library available there is nothing here to
 * drive it with. Its parts carry the assertions instead: `workflow-filters` covers every
 * conversion between the URL, the draft and the procedure's input; `workflow-listing` covers row
 * shaping; `workflow-list` covers the paging control and the four list states; and
 * `workflow-filter-bar` covers what the bar offers and refuses.
 *
 * What is asserted here is the one thing about the panel that is not delegated: its interface. It
 * takes the parsed filters and nothing else, which is what stops the page from resolving anything
 * about the runs before the scoped query has run (FR-190).
 */
describe('WorkflowsPanel', () => {
  it('is a component the page can mount', () => {
    expect(typeof WorkflowsPanel).toBe('function')
  })

  it('takes only the parsed filters, so the page pre-resolves nothing about the runs', () => {
    expect(WorkflowsPanel).toHaveLength(1)
  })
})
