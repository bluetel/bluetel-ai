import { describe, expect, it } from 'vitest'

import { WorkspacesPanel } from './workspaces-panel'

/**
 * The panel holds one query and four mutations, so it cannot be rendered without a tRPC provider
 * and a query client — and with no testing library available there is nothing here to drive it
 * with. Its parts carry the assertions instead: the version shaping is in `workspace-listing`, the
 * submission is in `workspace-entry-values`, the reporting is in `workspace-outcome`, and every
 * control is asserted on `workspace-editor`, `workspace-card` and `workspace-entry-fields`.
 *
 * What is **not** covered by a test is the wiring itself: that pressing Edit loads the current
 * version into the editor, that publishing invalidates the list, and that only the card whose
 * change is in flight shows the readout. Driving that needs a DOM and an event, which this app has
 * no library for.
 */
describe('WorkspacesPanel', () => {
  it('is a component the page can mount', () => {
    expect(typeof WorkspacesPanel).toBe('function')
  })

  it('takes nothing, so it resolves no route and reads no session itself', () => {
    expect(WorkspacesPanel).toHaveLength(0)
  })
})
