import { describe, expect, it } from 'vitest'

import { LogSegmentLine } from './log-segment-line'

/**
 * **Not covered.** This component's rendering. It calls `useQuery`, which needs a
 * `QueryClientProvider`, and there is no testing library here — so `renderToStaticMarkup` cannot
 * reach it. The decisions it makes about a response (`413` is "too large", any other failure is
 * "unavailable", and a `404` must stay indistinguishable from an out-of-scope refusal) live in the
 * fetch helper inside it and are asserted through the route's own tests in
 * `src/app/api/stream/segment-text.test.ts`, which own that vocabulary.
 *
 * What is asserted here is that the module loads without a provider — a client component that
 * evaluated a hook at module scope would fail the build rather than the render, and this is the
 * cheapest place to catch that.
 */
describe('LogSegmentLine', () => {
  it('is a component that can be imported without a query client', () => {
    expect(typeof LogSegmentLine).toBe('function')
  })
})
