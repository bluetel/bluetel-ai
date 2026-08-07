import { describe, expect, it, vi } from 'vitest'

import { memoiseAsync } from './memoise'

describe('memoiseAsync', () => {
  it('runs the loader once however many times it is called', async () => {
    const load = vi.fn(() => Promise.resolve('value'))
    const memoised = memoiseAsync(load)

    expect(await memoised()).toBe('value')
    expect(await memoised()).toBe('value')
    expect(await memoised()).toBe('value')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('does not run the loader at all until something asks', () => {
    const load = vi.fn(() => Promise.resolve('value'))
    memoiseAsync(load)

    expect(load).not.toHaveBeenCalled()
  })

  it('shares one in-flight promise between concurrent callers', async () => {
    let resolveLoad: ((value: number) => void) | undefined
    const load = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          resolveLoad = resolve
        }),
    )
    const memoised = memoiseAsync(load)

    const first = memoised()
    const second = memoised()
    resolveLoad?.(7)

    expect(await Promise.all([first, second])).toStrictEqual([7, 7])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('caches a rejection rather than silently retrying into a different answer', async () => {
    const load = vi.fn(() => Promise.reject(new Error('grants query failed')))
    const memoised = memoiseAsync(load)

    await expect(memoised()).rejects.toThrow('grants query failed')
    await expect(memoised()).rejects.toThrow('grants query failed')
    expect(load).toHaveBeenCalledTimes(1)
  })
})
