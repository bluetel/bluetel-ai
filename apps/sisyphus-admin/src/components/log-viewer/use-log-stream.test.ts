import { DEFAULT_STALE_TIME_MS } from '@sisyphus-admin/trpc'
import { describe, expect, it } from 'vitest'

import { LOG_VIEWER_STALE_TIME_MS, useLogStream } from './use-log-stream'

/**
 * What this file covers, and what it does not.
 *
 * **Covered.** The `staleTime` choice, which is the part of T077 that is invisible at the call
 * site and therefore the part most likely to be lost — and the hook's shape.
 *
 * **Not covered.** The subscription. There is no testing library in this repository, so the hook
 * is not rendered here: an `EventSource` and a `QueryClient` provider would both have to be faked,
 * and the result would assert React's behaviour rather than ours. Everything the hook *decides* is
 * in `./log-segment-store` and `./log-stream-events`, which are pure and directly tested — what is
 * genuinely not asserted is that the listeners are attached to the right event names and that the
 * source is closed on unmount. Stated plainly rather than implied by a green suite.
 */
describe('LOG_VIEWER_STALE_TIME_MS', () => {
  it('is shorter than the console default, because a live pane cannot sit on stale data (R6)', () => {
    expect(LOG_VIEWER_STALE_TIME_MS).toBeLessThan(DEFAULT_STALE_TIME_MS)
  })

  it('is at least one poll interval, so a remount does not refetch on every render', () => {
    expect(LOG_VIEWER_STALE_TIME_MS).toBeGreaterThanOrEqual(250)
  })

  it('leaves the shared default alone — it is set per query, not on the client', () => {
    expect(DEFAULT_STALE_TIME_MS).toBe(30_000)
  })
})

describe('useLogStream', () => {
  it('requires only the run, so the common case is one argument', () => {
    // `enabled` defaults to true and is therefore not counted in `length`.
    expect(useLogStream.length).toBe(1)
  })
})
