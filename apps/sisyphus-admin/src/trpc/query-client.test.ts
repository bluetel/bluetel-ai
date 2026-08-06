import { dehydrate, hydrate } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'

import { createQueryClient, DEFAULT_STALE_TIME_MS, getQueryClient } from './query-client'

describe('DEFAULT_STALE_TIME_MS', () => {
  it('is the thirty-second shared default', () => {
    expect(DEFAULT_STALE_TIME_MS).toBe(30_000)
  })
})

describe('createQueryClient', () => {
  it('applies the shared default to every query', () => {
    expect(createQueryClient().getDefaultOptions().queries?.staleTime).toBe(DEFAULT_STALE_TIME_MS)
  })

  /**
   * The property T077 depends on. A live log tail needs a much shorter window than the fleet view,
   * and it has to get one without a second client.
   */
  it('lets a single query override the default rather than baking it in', () => {
    const client = createQueryClient()
    const options = client.defaultQueryOptions({ queryKey: ['logs'], staleTime: 1_000 })
    expect(options.staleTime).toBe(1_000)
    expect(client.getDefaultOptions().queries?.staleTime).toBe(DEFAULT_STALE_TIME_MS)
  })

  it('carries a Date through dehydration, because the contract transformer is superjson', () => {
    const server = createQueryClient()
    server.setQueryData(['workflow', 'byId'], { startedAt: new Date('2026-08-05T09:00:00.000Z') })

    const client = createQueryClient()
    hydrate(client, dehydrate(server))

    const hydrated = client.getQueryData<{ startedAt: Date }>(['workflow', 'byId'])
    expect(hydrated?.startedAt).toBeInstanceOf(Date)
    expect(hydrated?.startedAt.toISOString()).toBe('2026-08-05T09:00:00.000Z')
  })

  it('dehydrates a still-pending query, so the client can pick up the server`s fetch', () => {
    const shouldDehydrate = createQueryClient().getDefaultOptions().dehydrate?.shouldDehydrateQuery
    expect(shouldDehydrate).toBeTypeOf('function')
  })
})

describe('getQueryClient', () => {
  it('hands out a fresh client per call on the server, so one request cannot serve another', () => {
    expect(getQueryClient()).not.toBe(getQueryClient())
  })

  it('reuses one client in the browser, so a re-render does not throw the cache away', () => {
    const globals = globalThis as { window?: unknown }
    globals.window = { location: { origin: 'http://localhost:3003' } }
    try {
      expect(getQueryClient()).toBe(getQueryClient())
    } finally {
      delete globals.window
    }
  })
})
