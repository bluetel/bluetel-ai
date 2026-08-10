import { describe, expect, it } from 'vitest'

import { ProfileCredentialGroupsPanel } from './profile-credential-groups-panel'

/**
 * The panel holds two queries and three mutations, so it cannot be rendered without a tRPC provider
 * and a query client, and this app has no testing library to drive one with. Its parts carry the
 * assertions instead: the FR-065 verdict is in `attachment-gate` and rendered by
 * `attachment-gate-notice`, which **is** rendered in a test and asserted to say its piece with
 * nothing submitted; the ordering is in `attachment-order`; the row's controls are on
 * `attachment-row`; and the three CONFLICT refusals are told apart in `attachment-outcome`.
 *
 * What is **not** covered is the wiring: that a refused detach lands on the row that was being
 * detached, and that a settled change invalidates `forProfile`.
 */
describe('ProfileCredentialGroupsPanel', () => {
  it('is a component the page can mount', () => {
    expect(typeof ProfileCredentialGroupsPanel).toBe('function')
  })

  it('takes the profile id from its caller rather than resolving a route itself', () => {
    expect(ProfileCredentialGroupsPanel).toHaveLength(1)
  })
})
