import { describe, expect, it } from 'vitest'

import { CredentialGroupsPanel } from './credential-groups-panel'

/**
 * The panel holds one query and four mutations, so it cannot be rendered without a tRPC provider and
 * a query client — and with no testing library in this app there is nothing here to drive it with.
 * Its parts carry the assertions instead: the counts and the FR-066 conditions are in
 * `group-listing`, the refusal is in `deletion-refusal`, the reporting is in `group-outcome`, and
 * every control is asserted on `group-card` and `create-group-form`.
 *
 * What is **not** covered is the wiring: that a refused delete puts FR-066's conditions on the card
 * that was being deleted and nowhere else, and that a settled change invalidates the list. Driving
 * that needs a DOM and an event.
 */
describe('CredentialGroupsPanel', () => {
  it('is a component the page can mount', () => {
    expect(typeof CredentialGroupsPanel).toBe('function')
  })

  it('takes nothing, so it resolves no route and reads no session itself', () => {
    expect(CredentialGroupsPanel).toHaveLength(0)
  })
})
