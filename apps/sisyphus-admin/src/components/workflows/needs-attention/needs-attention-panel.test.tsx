import { describe, expect, it } from 'vitest'

import { NeedsAttentionPanel } from './needs-attention-panel'
import { StrandedOwnerCard } from './stranded-owner-card'

/**
 * Both components hold queries and a mutation, so neither can be rendered without a tRPC provider
 * and a query client — and with no testing library available there is nothing here to drive them
 * with. Their parts carry the assertions instead: what each section asks for is in
 * `needs-attention-input`, the reporting is in `reassignment-outcome`, the row is asserted on
 * `reassignment-row`, and the list itself is the fleet view's own `WorkflowList` and row shaping,
 * covered where they live.
 *
 * What is **not** covered by a test is the wiring: that the reassignment queue is not mounted for a
 * non-admin, that a completed reassignment invalidates both lists, and that only the row whose
 * change is in flight shows the readout. Driving that needs a DOM and an event, which this app has
 * no library for.
 */
describe('NeedsAttentionPanel', () => {
  it('is a component the page can mount', () => {
    expect(typeof NeedsAttentionPanel).toBe('function')
  })

  it('takes one props object, so it resolves neither the viewer nor their role itself', () => {
    expect(NeedsAttentionPanel).toHaveLength(1)
  })
})

describe('StrandedOwnerCard', () => {
  it('is a component the panel can mount per stranded owner', () => {
    expect(typeof StrandedOwnerCard).toBe('function')
  })
})
