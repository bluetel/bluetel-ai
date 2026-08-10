import { describe, expect, it } from 'vitest'

import { CredentialPoolPanel } from './credential-pool-panel'

/**
 * The panel holds one query, so it cannot be rendered without a tRPC provider and a query client —
 * and with no testing library available there is nothing here to drive it with. Its parts carry the
 * assertions instead: the SC-011 wording is in `pool-readout`, and the group card is asserted on
 * `pool-group-card`.
 *
 * What is asserted here is the one structural claim about the panel itself: it takes nothing, so it
 * resolves no route and reads no session of its own — the page's server gate is the only gate, and a
 * panel with a parameter would be a second place someone could decide who may look.
 */
describe('CredentialPoolPanel', () => {
  it('is a component the page can mount', () => {
    expect(typeof CredentialPoolPanel).toBe('function')
  })

  it('takes nothing, so it resolves no route and reads no session itself', () => {
    expect(CredentialPoolPanel).toHaveLength(0)
  })
})
