import { describe, expect, it } from 'vitest'

import { IntegrationsScreen } from './integrations-screen'

/**
 * The screen holds two queries and the adapter hook, so it cannot be rendered without a tRPC
 * provider and a query client. Everything it decides lives in a module beside it with its own test:
 * the two option lists in `integration-options`, the row mapping in `integration-view`, and every
 * control on the panel's own parts.
 */
describe('IntegrationsScreen', () => {
  it('is a component the page can mount', () => {
    expect(typeof IntegrationsScreen).toBe('function')
  })

  it('takes nothing, so the page hands it no data and it reads its own', () => {
    expect(IntegrationsScreen).toHaveLength(0)
  })
})
