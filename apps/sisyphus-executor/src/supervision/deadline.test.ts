import { afterEach, describe, expect, it, vi } from 'vitest'

import { DeadlineExceededError, isDeadlineExceeded, withDeadline } from './deadline'

/**
 * The point of these is that the deadline *fires*. A helper that only ever returns the operation's
 * value is indistinguishable from no helper at all, which is the state T185 found the budget in.
 */

describe('withDeadline', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the operation’s value when it settles inside the term', async () => {
    await expect(
      withDeadline(() => Promise.resolve('done'), { operation: 'a read', budgetMs: 1_000 }),
    ).resolves.toBe('done')
  })

  it('rejects with the term and the operation when the budget elapses first', async () => {
    vi.useFakeTimers()

    const pending = withDeadline(() => new Promise<never>(() => undefined), {
      operation: 'pulling supervision commands',
      budgetMs: 1_000,
    })
    const settled = expect(pending).rejects.toBeInstanceOf(DeadlineExceededError)

    await vi.advanceTimersByTimeAsync(1_000)
    await settled

    await expect(pending).rejects.toThrow(/pulling supervision commands/)
    await expect(pending).rejects.toThrow(/1000ms/)
  })

  it('lets the operation’s own failure through unchanged, rather than reporting it as slow', async () => {
    const boom = new Error('the surface refused it')

    await expect(
      withDeadline(() => Promise.reject(boom), {
        operation: 'acknowledging a command',
        budgetMs: 1_000,
      }),
    ).rejects.toBe(boom)
  })

  it('treats a non-positive budget as unbounded, so "no term here" needs no second path', async () => {
    vi.useFakeTimers()

    const finished = withDeadline(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => {
            resolve('eventually')
          }, 60_000)
        }),
      { operation: 'an unbounded wait', budgetMs: 0 },
    )

    await vi.advanceTimersByTimeAsync(60_000)

    await expect(finished).resolves.toBe('eventually')
  })

  it('clears its timer, so a fast operation leaves nothing pending behind it', async () => {
    vi.useFakeTimers()

    await expect(
      withDeadline(() => Promise.resolve('fast'), { operation: 'a read', budgetMs: 5_000 }),
    ).resolves.toBe('fast')

    expect(vi.getTimerCount()).toBe(0)
  })

  it('recognises its own error, so a caller can tell a blown term from a refusal', () => {
    expect(isDeadlineExceeded(new DeadlineExceededError({ operation: 'x', budgetMs: 1 }))).toBe(
      true,
    )
    expect(isDeadlineExceeded(new Error('x'))).toBe(false)
  })
})
