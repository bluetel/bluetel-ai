import { describe, expect, it } from 'vitest'

import * as trpc from './index'

describe('the tRPC barrel', () => {
  it('publishes the client, the provider, the query client and the RSC helper', () => {
    expect(Object.keys(trpc).sort()).toStrictEqual([
      'DEFAULT_STALE_TIME_MS',
      'HydrateClient',
      'TRPCReactProvider',
      'api',
      'createQueryClient',
      'getQueryClient',
      'resolveBaseUrl',
      'resolveTrpcUrl',
    ])
  })

  it('exports no router implementation, so nothing here can reach a resolver or the driver', () => {
    expect(Object.keys(trpc)).not.toContain('appRouter')
    expect(Object.keys(trpc)).not.toContain('createCaller')
    expect(Object.keys(trpc)).not.toContain('db')
  })
})
