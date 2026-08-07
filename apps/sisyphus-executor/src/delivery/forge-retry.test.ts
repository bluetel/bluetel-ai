import { describe, expect, it } from 'vitest'

import { ForgeError } from './forge-error'
import type { ForgeRetryPolicy } from './forge-retry'
import { DEFAULT_FORGE_RETRY_POLICY, forgeRetryDelayMs, withForgeRetry } from './forge-retry'

/**
 * The policy is asserted as arithmetic, not as elapsed time. Nothing here
 * waits: `sleep` is injected and records what it was asked for, which is the
 * only way "a single 502 does not fail the run, and nothing retries forever"
 * is a checkable claim rather than a comment.
 */

const slept: number[] = []

const policy = (overrides: Partial<ForgeRetryPolicy> = {}): ForgeRetryPolicy => ({
  ...DEFAULT_FORGE_RETRY_POLICY,
  sleep: async (milliseconds: number) => {
    slept.push(milliseconds)

    return Promise.resolve()
  },
  ...overrides,
})

const transient = (): ForgeError => new ForgeError({ kind: 'transient', operation: 'branchHead' })

const throttled = (retryAfterMs: number): ForgeError =>
  new ForgeError({ kind: 'rate_limited', operation: 'branchHead', retryAfterMs })

describe('the default policy', () => {
  it('is three attempts, a 250ms doubling backoff and a five second ceiling', () => {
    // Stated here so a change to any of them is a change to a test that says
    // what the number means, rather than a silent adjustment.
    expect(DEFAULT_FORGE_RETRY_POLICY).toStrictEqual({
      maxAttempts: 3,
      baseDelayMs: 250,
      maxDelayMs: 5000,
    })
  })
})

describe('forgeRetryDelayMs', () => {
  it('doubles the backoff for each attempt already spent', () => {
    expect(forgeRetryDelayMs(policy(), 1, transient())).toBe(250)
    expect(forgeRetryDelayMs(policy({ maxAttempts: 10 }), 2, transient())).toBe(500)
    expect(forgeRetryDelayMs(policy({ maxAttempts: 10 }), 3, transient())).toBe(1000)
  })

  it('never exceeds the ceiling, however many attempts are allowed', () => {
    expect(forgeRetryDelayMs(policy({ maxAttempts: 20 }), 10, transient())).toBe(5000)
  })

  it('stops once the attempt budget is spent', () => {
    expect(forgeRetryDelayMs(policy(), 3, transient())).toBeUndefined()
  })

  it('does not retry at all when the budget is one attempt', () => {
    expect(forgeRetryDelayMs(policy({ maxAttempts: 1 }), 1, transient())).toBeUndefined()
  })

  it.each(['not_found', 'unauthorised', 'conflict', 'invalid'] as const)(
    'refuses to retry %s, which asking again cannot change',
    (kind) => {
      expect(
        forgeRetryDelayMs(policy(), 1, new ForgeError({ kind, operation: 'branchHead' })),
      ).toBeUndefined()
    },
  )

  it('refuses to retry something that is not a forge failure', () => {
    expect(forgeRetryDelayMs(policy(), 1, new Error('bug in this client'))).toBeUndefined()
  })

  it('honours a wait the host asked for, in preference to the backoff', () => {
    expect(forgeRetryDelayMs(policy(), 1, throttled(1200))).toBe(1200)
  })

  it('refuses the retry outright when the host’s wait exceeds the ceiling', () => {
    // The alternative is waiting out a reset for minutes, which is
    // indistinguishable from a hang to everyone watching the panel.
    expect(forgeRetryDelayMs(policy(), 1, throttled(1_800_000))).toBeUndefined()
  })
})

describe('withForgeRetry', () => {
  it('does not fail a run on one 502', async () => {
    slept.length = 0
    let attempts = 0

    const result = await withForgeRetry(policy(), async () => {
      attempts += 1

      if (attempts === 1) {
        return Promise.reject(transient())
      }

      return Promise.resolve('opened')
    })

    expect(result).toBe('opened')
    expect(attempts).toBe(2)
    expect(slept).toStrictEqual([250])
  })

  it('gives up after the declared number of attempts, and throws the last failure', async () => {
    slept.length = 0
    let attempts = 0
    const last = transient()

    await expect(
      withForgeRetry(policy(), async () => {
        attempts += 1

        return Promise.reject(attempts === 3 ? last : transient())
      }),
    ).rejects.toBe(last)

    expect(attempts).toBe(3)
    expect(slept).toStrictEqual([250, 500])
  })

  it('fails immediately on a credential problem rather than trying twice more', async () => {
    slept.length = 0
    let attempts = 0

    await expect(
      withForgeRetry(policy(), async () => {
        attempts += 1

        return Promise.reject(new ForgeError({ kind: 'unauthorised', operation: 'branchHead' }))
      }),
    ).rejects.toThrow(/unauthorised/)

    expect(attempts).toBe(1)
    expect(slept).toStrictEqual([])
  })

  it('runs the operation afresh each attempt, so a retry can look before it creates', async () => {
    slept.length = 0
    const seen: number[] = []

    await withForgeRetry(policy(), async (attempt) => {
      seen.push(attempt)

      if (attempt < 3) {
        return Promise.reject(transient())
      }

      return Promise.resolve('done')
    })

    expect(seen).toStrictEqual([1, 2, 3])
  })

  it('waits exactly as long as the host asked, when it asked', async () => {
    slept.length = 0
    let attempts = 0

    await withForgeRetry(policy(), async () => {
      attempts += 1

      if (attempts === 1) {
        return Promise.reject(throttled(900))
      }

      return Promise.resolve('done')
    })

    expect(slept).toStrictEqual([900])
  })
})
