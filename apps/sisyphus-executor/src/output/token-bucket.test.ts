import { describe, expect, it } from 'vitest'

import { createTokenBucket } from './token-bucket'

const withClock = (): { readonly advance: (ms: number) => void; readonly now: () => number } => {
  let moment = 0

  return {
    advance: (ms: number): void => {
      moment += ms
    },
    now: (): number => moment,
  }
}

describe('createTokenBucket', () => {
  it('starts full', () => {
    const clock = withClock()

    expect(createTokenBucket({ ratePerSecond: 1, burst: 3, now: clock.now }).available()).toBe(3)
  })

  it('allows the burst and then refuses', () => {
    const clock = withClock()
    const bucket = createTokenBucket({ ratePerSecond: 1, burst: 2, now: clock.now })

    expect(bucket.tryTake()).toBe(true)
    expect(bucket.tryTake()).toBe(true)
    expect(bucket.tryTake()).toBe(false)
  })

  it('refills at the configured rate', () => {
    const clock = withClock()
    const bucket = createTokenBucket({ ratePerSecond: 2, burst: 2, now: clock.now })

    bucket.tryTake()
    bucket.tryTake()
    clock.advance(500)

    expect(bucket.tryTake()).toBe(true)
    expect(bucket.tryTake()).toBe(false)
  })

  it('never refills beyond the burst allowance', () => {
    const clock = withClock()
    const bucket = createTokenBucket({ ratePerSecond: 10, burst: 3, now: clock.now })

    clock.advance(60_000)

    expect(bucket.available()).toBe(3)
  })

  it('tolerates a clock that does not move', () => {
    const bucket = createTokenBucket({ ratePerSecond: 1, burst: 1, now: () => 0 })

    expect(bucket.tryTake()).toBe(true)
    expect(bucket.tryTake()).toBe(false)
  })
})
