/**
 * Rate limiting for segment delivery (T060, FR-047).
 *
 * A token bucket rather than a fixed window because the failure it guards
 * against is bursty: an agent that dumps a build log produces a thousand
 * segments in a second and then nothing for a minute. A burst allowance
 * absorbs that without letting the sustained rate drift up.
 *
 * Crucially this limiter never authorises a drop. It decides *when* a segment
 * leaves, never *whether* — output that exceeds the rate stays queued and is
 * delivered as more segments later. FR-047 says no output is lost on a
 * high-volume run, and a limiter that could say "no" would be the easiest
 * place to lose it.
 */

export interface TokenBucketOptions {
  /** Sustained rate, in permits per second. */
  readonly ratePerSecond: number
  /** How many permits may be spent at once after an idle period. */
  readonly burst: number
  /** Injected so tests do not wait in real time. */
  readonly now: () => number
}

export interface TokenBucket {
  /** Spend one permit if one is available. */
  readonly tryTake: () => boolean
  /** Permits currently available, refilled to the present moment. */
  readonly available: () => number
}

const MILLISECONDS_PER_SECOND = 1000

export const createTokenBucket = (options: TokenBucketOptions): TokenBucket => {
  let tokens = options.burst
  let lastRefill = options.now()

  const refill = (): void => {
    const moment = options.now()
    const elapsed = Math.max(moment - lastRefill, 0)

    tokens = Math.min(
      options.burst,
      tokens + (elapsed / MILLISECONDS_PER_SECOND) * options.ratePerSecond,
    )
    lastRefill = moment
  }

  return {
    tryTake: (): boolean => {
      refill()

      if (tokens < 1) {
        return false
      }

      tokens -= 1

      return true
    },

    available: (): number => {
      refill()

      return tokens
    },
  }
}
