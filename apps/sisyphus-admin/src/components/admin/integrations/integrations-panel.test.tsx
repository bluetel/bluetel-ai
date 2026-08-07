import { describe, expect, it } from 'vitest'

import { IntegrationsPanel } from './integrations-panel'

/**
 * The panel holds the screen's state and its effects, so it cannot be rendered without a React
 * runtime that runs them — and with no testing library available there is nothing here to drive it
 * with. Its parts carry the assertions instead: the schedule reading is in `cron-schedule` and
 * `schedule-presets`, the submission in `integration-form-values`, the row shaping in
 * `integration-listing`, and every control is asserted on `integration-card`, `integration-editor`,
 * `credential-field`, `schedule-field` and `prompt-preview`.
 *
 * What is **not** covered by a test is the wiring itself: that a refused action puts its error on
 * the card it came from and nowhere else, that pressing Edit loads the integration into the editor
 * with the credential blank, and that cancelling clears the draft. Driving that needs a DOM and an
 * event, which this app has no library for.
 */
describe('IntegrationsPanel', () => {
  it('is a component the page can mount', () => {
    expect(typeof IntegrationsPanel).toBe('function')
  })

  it('takes its server access as an argument, so it reads nothing on its own', () => {
    expect(IntegrationsPanel).toHaveLength(1)
  })
})
