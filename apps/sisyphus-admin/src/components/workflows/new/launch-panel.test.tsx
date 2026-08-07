import { describe, expect, it } from 'vitest'

import { LaunchPanel } from './launch-panel'

/**
 * The panel holds three queries and two mutations, so it cannot be rendered without a tRPC provider
 * and a query client — and with no testing library available there is nothing here to drive it
 * with. Its parts carry the assertions instead: the prefill is in `profile-prefill`, the
 * locked-field decision is in `profile-locks`, the submission is in `profile-launch-values`, the
 * reporting is in `launch-outcome`, and every control is asserted on `profile-launch-form`,
 * `profile-launch-fields`, `locked-value`, `ad-hoc-launch-form`, `launch-select` and
 * `prompt-field`.
 *
 * What is **not** covered by a test is the wiring itself: that choosing a profile calls
 * `prefillFromProfile` and re-renders the form with it, that pressing the button calls
 * `workflow.start` with the parsed input, and that a success clears the prompt. Driving that needs
 * a DOM and an event, which this app has no library for.
 */
describe('LaunchPanel', () => {
  it('is a component the page can mount', () => {
    expect(typeof LaunchPanel).toBe('function')
  })

  it('takes one props object, so it resolves neither the caller’s role nor a route itself', () => {
    expect(LaunchPanel).toHaveLength(1)
  })
})
