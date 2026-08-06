import { describe, expect, it } from 'vitest'

import { DEFAULT_WINDOW, LogViewer } from './log-viewer'

/**
 * The viewer is composition, and its parts are tested where they live: reconciliation in
 * `./log-segment-store.test`, decoding and status in `./log-stream-events.test`, rendering in
 * `./log-line.test` and `./log-pane.test`, the URLs in `./log-stream-url.test`.
 *
 * **Not covered.** Rendering *this* component. It calls `useLogStream`, which needs a
 * `QueryClientProvider` and an `EventSource`, and there is no testing library here to supply
 * either. What is asserted is the contract another page depends on — the props and the window —
 * plus the invariant that would make the window meaningless.
 */
describe('LogViewer', () => {
  it('renders a bounded tail, so an hour-long run does not open thousands of object reads', () => {
    expect(DEFAULT_WINDOW).toBeGreaterThan(0)
    expect(DEFAULT_WINDOW).toBeLessThanOrEqual(500)
  })

  it('takes the run, an enabled flag and a window', () => {
    expect(typeof LogViewer).toBe('function')
    expect(LogViewer.length).toBe(1)
  })
})
