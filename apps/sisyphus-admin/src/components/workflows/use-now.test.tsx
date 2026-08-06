import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { NOW_TICK_MS, useNow } from './use-now'

/**
 * With no testing library there is no way to advance a React effect here, so what is settled is the
 * property that matters and that a browser test would not catch: the **first** value is
 * `undefined`.
 *
 * That is the hydration contract. A hook that seeded itself from `Date.now()` would render one
 * value on the server and a different one in the browser, and React would report a mismatch on a
 * value nobody chose. `renderToStaticMarkup` runs no effects, so it observes exactly the first
 * value the server produces.
 */

const Probe = () => <span>{String(useNow())}</span>

describe('useNow', () => {
  it('has no clock on the first render, so the server and the browser agree', () => {
    expect(renderToStaticMarkup(<Probe />)).toBe('<span>undefined</span>')
  })

  it('advances once a second, because durations are displayed to the second', () => {
    expect(NOW_TICK_MS).toBe(1000)
  })
})
