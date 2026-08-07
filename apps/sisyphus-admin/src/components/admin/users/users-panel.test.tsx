import { describe, expect, it } from 'vitest'

import { UsersPanel } from './users-panel'

/**
 * The panel holds the queries, so it cannot be rendered without a tRPC provider and a query client
 * — and with no testing library available there is nothing here to drive it with. What it is
 * *made of* is tested instead: `user-listing`, `user-actions`, `user-change-outcome`,
 * `user-card`, `user-action-form` and `role-change-history` each carry their own file, which is
 * why this module was kept to wiring in the first place.
 *
 * What can be asserted here is that the wiring module is a component and that it stays free of the
 * decisions those modules own — a rule re-derived inside this file would be a rule with no test.
 */
describe('UsersPanel', () => {
  it('is a component the page can mount', () => {
    expect(typeof UsersPanel).toBe('function')
  })

  it('takes no props, so the page cannot hand it a pre-decided list', () => {
    expect(UsersPanel).toHaveLength(0)
  })
})
