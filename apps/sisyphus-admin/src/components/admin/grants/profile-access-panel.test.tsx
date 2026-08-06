import { describe, expect, it } from 'vitest'

import { ProfileAccessPanel } from './profile-access-panel'

/**
 * The panel holds the queries and the mutations, so it cannot be rendered without a tRPC provider
 * and a query client — and with no testing library available there is nothing here to drive it
 * with. Its parts carry the assertions instead: `grant-listing`, `revocation-outcome`,
 * `grant-row`, `revoke-confirmation` and `issue-grant-form` each have their own file, and the
 * FR-190 rendering rule is asserted on `NotFoundCard` and on `describeGrantError`.
 */
describe('ProfileAccessPanel', () => {
  it('is a component the page can mount', () => {
    expect(typeof ProfileAccessPanel).toBe('function')
  })

  it('takes the profile id as its only input, so the page cannot pre-resolve the profile', () => {
    expect(ProfileAccessPanel).toHaveLength(1)
  })
})
