import { describe, expect, it } from 'vitest'

import { CredentialsPanel } from './credentials-panel'

/**
 * The panel holds two queries and four mutations, so it cannot be rendered without a tRPC provider
 * and a query client — and with no testing library available there is nothing here to drive it
 * with. Its parts carry the assertions instead: the shaping is in `credential-listing`, and every
 * control is asserted on `credential-row` and `register-credential-form`.
 *
 * What is **not** covered by a test is the wiring itself: that recording a secret invalidates the
 * list, that only the row whose change is in flight shows a readout, and that a refusal is attached
 * to the row it came from. Driving that needs a DOM and an event, which this app has no library for.
 */
describe('CredentialsPanel', () => {
  it('is a component the page can mount', () => {
    expect(typeof CredentialsPanel).toBe('function')
  })

  it('takes nothing, so it resolves no route and reads no session itself', () => {
    expect(CredentialsPanel).toHaveLength(0)
  })
})
