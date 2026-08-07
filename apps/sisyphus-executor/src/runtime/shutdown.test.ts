import { describe, expect, it, vi } from 'vitest'

import { createShutdownRegistry } from './shutdown'

describe('createShutdownRegistry', () => {
  it('starts out not shutting down', () => {
    expect(createShutdownRegistry().isShuttingDown).toBe(false)
  })

  it('runs hooks in reverse registration order', async () => {
    const registry = createShutdownRegistry()
    const order: string[] = []

    registry.onShutdown(() => {
      order.push('first')
    })
    registry.onShutdown(() => {
      order.push('second')
    })

    await registry.shutdown({ source: 'SIGTERM' })

    expect(order).toStrictEqual(['second', 'first'])
  })

  it('awaits async hooks before resolving', async () => {
    const registry = createShutdownRegistry()
    let finished = false

    registry.onShutdown(async () => {
      await Promise.resolve()
      finished = true
    })

    await registry.shutdown({ source: 'internal' })

    expect(finished).toBe(true)
  })

  it('runs each hook exactly once across repeated shutdown calls', async () => {
    const registry = createShutdownRegistry()
    const hook = vi.fn()

    registry.onShutdown(hook)

    await Promise.all([
      registry.shutdown({ source: 'SIGTERM' }),
      registry.shutdown({ source: 'SIGINT' }),
    ])
    await registry.shutdown({ source: 'SIGINT' })

    expect(hook).toHaveBeenCalledTimes(1)
  })

  it('reports the reason from the first shutdown call', async () => {
    const registry = createShutdownRegistry()

    const [first, second] = await Promise.all([
      registry.shutdown({ source: 'SIGTERM' }),
      registry.shutdown({ source: 'SIGINT' }),
    ])

    expect(first.reason.source).toBe('SIGTERM')
    expect(second).toBe(first)
  })

  it('keeps running hooks after one throws, and collects the errors', async () => {
    const registry = createShutdownRegistry()
    const survivor = vi.fn()

    registry.onShutdown(survivor)
    registry.onShutdown(() => {
      throw new Error('snapshot failed')
    })

    const result = await registry.shutdown({ source: 'SIGTERM' })

    expect(survivor).toHaveBeenCalledTimes(1)
    expect(result.errors.map((error) => error.message)).toStrictEqual(['snapshot failed'])
  })

  it('wraps a non-Error throw', async () => {
    const registry = createShutdownRegistry()

    registry.onShutdown(() => {
      // Deliberately not an Error — the registry has to cope with third-party
      // code that throws a bare value.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'plain string'
    })

    const result = await registry.shutdown({ source: 'internal' })

    expect(result.errors[0]).toBeInstanceOf(Error)
    expect(result.errors[0]?.message).toBe('plain string')
  })

  it('does not run a hook that was unregistered', async () => {
    const registry = createShutdownRegistry()
    const hook = vi.fn()

    const remove = registry.onShutdown(hook)
    remove()

    await registry.shutdown({ source: 'internal' })

    expect(hook).not.toHaveBeenCalled()
  })

  it('reports isShuttingDown once shutdown has begun', async () => {
    const registry = createShutdownRegistry()

    const pending = registry.shutdown({ source: 'SIGTERM' })

    expect(registry.isShuttingDown).toBe(true)

    await pending
  })
})
