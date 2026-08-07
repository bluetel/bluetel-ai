import { describe, expect, it } from 'vitest'

import { api } from './api'

describe('api', () => {
  it('is a tRPC React client with a provider and a client factory', () => {
    expect(typeof api.Provider).toBe('function')
    expect(typeof api.createClient).toBe('function')
    expect(typeof api.useUtils).toBe('function')
  })

  it('resolves procedure hooks lazily through its proxy', () => {
    expect(api.health).toBeDefined()
  })
})
