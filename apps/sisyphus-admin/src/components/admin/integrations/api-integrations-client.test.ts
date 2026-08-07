import { describe, expect, it } from 'vitest'

import { INTEGRATION_LIST_LIMIT, useIntegrationsApiClient } from './api-integrations-client'

/**
 * The adapter is a hook over `api.useUtils()`, so it cannot be called outside a tRPC provider and
 * this app has no testing library to mount one with. What it forwards is asserted where it can be:
 * the shape it returns is `IntegrationsClient`, checked by `tsc`; the mapping it applies on the way
 * out is `integration-view.test.ts`; and the credential's absence is a compile-time assertion in
 * `integration-view.ts` rather than a runtime step this file could skip.
 *
 * What is **not** covered by a test is the wiring itself: that every mutation invalidates the list
 * before resolving, and that `previewPrompt` opts out of the cache. Driving that needs a mounted
 * provider and a query client.
 */
describe('useIntegrationsApiClient', () => {
  it('is a hook the screen can call', () => {
    expect(typeof useIntegrationsApiClient).toBe('function')
  })

  it('takes nothing, so it reads no session and resolves no route itself', () => {
    expect(useIntegrationsApiClient).toHaveLength(0)
  })
})

describe('INTEGRATION_LIST_LIMIT', () => {
  it('matches the other admin listings, so one deployment does not page differently', () => {
    expect(INTEGRATION_LIST_LIMIT).toBe(50)
  })
})
