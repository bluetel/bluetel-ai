'use client'

import { useEffect, useState } from 'react'

/**
 * The clock a live duration is measured against.
 *
 * ## Why this is a hook and not `Date.now()` in the component body
 *
 * `Date.now()` during render is impure: two renders of the same props produce different output, so
 * a re-render React performs for its own reasons silently changes what the page says. It is also a
 * hydration hazard — the server reads its clock, the browser reads a different one, and React
 * reports a mismatch on a value nobody deliberately chose.
 *
 * So the clock arrives through state, and the **first** value is deliberately `undefined`. The
 * server render and the first client render therefore agree, and a live run's duration is shown
 * measured against its last recorded movement — which is the honest thing a render with no clock
 * can say. One tick later the interval supplies a real timestamp and live runs begin to advance.
 *
 * The first timestamp comes from the interval rather than from the effect body. Setting state
 * synchronously on mount would buy at most one second of accuracy at the cost of a second render
 * of the whole list, on a page whose durations are displayed to the second anyway.
 *
 * Reading it once per page rather than once per row is what keeps every duration on screen
 * agreeing with every other.
 */

/** How often the clock advances. One second, because durations are displayed to the second. */
export const NOW_TICK_MS = 1000

/**
 * A timestamp that advances once a second, or `undefined` until the browser has one.
 *
 * @param tickMs - How often to advance. Injectable so a caller that renders a slower page can say
 *   so; the default is the only value the panel uses.
 */
export const useNow = (tickMs: number = NOW_TICK_MS): number | undefined => {
  const [now, setNow] = useState<number | undefined>(undefined)

  useEffect(() => {
    // Set only from the interval, never synchronously in the effect body: a synchronous set here
    // is a second render immediately after mount, for a value that is about to arrive anyway.
    const timer = setInterval(() => {
      setNow(Date.now())
    }, tickMs)

    return () => {
      clearInterval(timer)
    }
  }, [tickMs])

  return now
}
