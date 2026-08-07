import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createPauseIdleCeiling,
  PAUSE_IDLE_CEILING_MS,
  pauseIdleCeilingReason,
} from './idle-ceiling'

/**
 * The requirement is US2 §4: a paused workflow nobody comes back to is parked and its instance
 * released. Before T181 `'on-idle-ceiling'` was a string with no clock behind it, so the tests
 * that matter here are the ones that fail if the clock is removed again — the expiry, and the
 * cancellation that keeps a resumed run from being parked mid-work.
 */

const PAUSED_AT = new Date('2026-08-05T12:00:00.000Z')

describe('the pause idle ceiling', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves once a pause outlives the ceiling', async () => {
    vi.useFakeTimers()
    const ceiling = createPauseIdleCeiling({ ceilingMs: 1_000, now: () => new Date(Date.now()) })

    ceiling.begin(new Date(Date.now()))
    const expired = ceiling.expired

    await vi.advanceTimersByTimeAsync(1_000)

    await expect(expired).resolves.toMatchObject({ ceilingMs: 1_000, idleMs: 1_000 })
  })

  it('does not resolve for a pause that is still inside the ceiling', async () => {
    vi.useFakeTimers()
    const ceiling = createPauseIdleCeiling({ ceilingMs: 10_000, now: () => new Date(Date.now()) })
    let expired = false

    void ceiling.expired.then(() => {
      expired = true
    })
    ceiling.begin(new Date(Date.now()))

    await vi.advanceTimersByTimeAsync(9_999)

    expect(expired).toBe(false)
  })

  it('never resolves for a run that is never paused, so it is safe to race unconditionally', async () => {
    vi.useFakeTimers()
    const ceiling = createPauseIdleCeiling({ ceilingMs: 1_000 })
    let expired = false

    void ceiling.expired.then(() => {
      expired = true
    })

    await vi.advanceTimersByTimeAsync(60_000)

    expect(expired).toBe(false)
  })

  it('stops counting when the run is resumed, so a resumed run is not parked mid-work', async () => {
    vi.useFakeTimers()
    const ceiling = createPauseIdleCeiling({ ceilingMs: 1_000, now: () => new Date(Date.now()) })
    let expired = false

    void ceiling.expired.then(() => {
      expired = true
    })
    ceiling.begin(new Date(Date.now()))

    await vi.advanceTimersByTimeAsync(500)
    ceiling.cancel()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(expired).toBe(false)
    expect(ceiling.pausedAt()).toBeUndefined()
  })

  it('counts from when the pause began, not from when it was told about it', async () => {
    // The pause snapshot may have parked on unreachable storage for a while. Those seconds belong
    // to the platform, not to the engineer's allowance, so the remaining time is measured from the
    // suspension's own timestamp.
    vi.useFakeTimers()
    vi.setSystemTime(PAUSED_AT)

    const ceiling = createPauseIdleCeiling({ ceilingMs: 1_000, now: () => new Date(Date.now()) })

    ceiling.begin(new Date(PAUSED_AT.getTime() - 900))
    const expired = ceiling.expired

    await vi.advanceTimersByTimeAsync(100)

    await expect(expired).resolves.toMatchObject({ idleMs: 1_000 })
  })

  it('expires immediately for a pause that already outlived the ceiling before it was armed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(PAUSED_AT)

    const ceiling = createPauseIdleCeiling({ ceilingMs: 1_000, now: () => new Date(Date.now()) })

    ceiling.begin(new Date(PAUSED_AT.getTime() - 60_000))
    const expired = ceiling.expired

    await vi.advanceTimersByTimeAsync(0)

    await expect(expired).resolves.toMatchObject({ idleMs: 60_000 })
  })

  it('reports when the instance will be handed back, so a panel can say so', () => {
    const ceiling = createPauseIdleCeiling({ ceilingMs: 1_000, now: () => PAUSED_AT })

    expect(ceiling.expiresAt()).toBeUndefined()
    ceiling.begin(PAUSED_AT)
    expect(ceiling.expiresAt()).toStrictEqual(new Date(PAUSED_AT.getTime() + 1_000))
  })

  it('defaults to a ceiling long enough that an ordinary pause is not a restore cycle', () => {
    expect(PAUSE_IDLE_CEILING_MS).toBeGreaterThanOrEqual(10 * 60 * 1000)
  })
})

describe('the reason a parked pause reports', () => {
  it('says parked, not failed, because a person who cannot tell assumes their work is gone', () => {
    const reason = pauseIdleCeilingReason({
      pausedAt: PAUSED_AT,
      idleMs: 1_800_000,
      ceilingMs: PAUSE_IDLE_CEILING_MS,
    })

    expect(reason).toContain('Nothing was lost and nothing failed')
    expect(reason).toContain('1800s')
    expect(reason).toContain(PAUSED_AT.toISOString())
    expect(reason).not.toMatch(/\bfailed\b(?!:)/i)
  })
})
