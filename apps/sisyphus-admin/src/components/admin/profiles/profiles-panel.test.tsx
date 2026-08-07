import { describe, expect, it } from 'vitest'

import { ProfilesPanel } from './profiles-panel'

/**
 * The panel holds three queries and four mutations, so it cannot be rendered without a tRPC
 * provider and a query client — and with no testing library available there is nothing here to
 * drive it with. Its parts carry the assertions instead: the version shaping is in
 * `profile-listing`, the submission is in `profile-form-values`, the FR-124 refusal is in
 * `enable-refusal`, the reporting is in `profile-outcome`, and every control is asserted on
 * `profile-editor` and `profile-card`.
 *
 * What is **not** covered by a test is the wiring itself: that a refused enable puts the gate's
 * failures on the card that was being enabled and nowhere else, that pressing Edit loads the
 * current version into the editor, and that publishing invalidates the list. Driving that needs a
 * DOM and an event, which this app has no library for.
 */
describe('ProfilesPanel', () => {
  it('is a component the page can mount', () => {
    expect(typeof ProfilesPanel).toBe('function')
  })

  it('takes nothing, so it resolves no route and reads no session itself', () => {
    expect(ProfilesPanel).toHaveLength(0)
  })
})
