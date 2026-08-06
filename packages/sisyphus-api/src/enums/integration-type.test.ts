import { describe, expect, it } from 'vitest'

import { INTEGRATION_TYPES, isIntegrationType } from './integration-type'

describe('INTEGRATION_TYPES', () => {
  it('carries only the type in scope for this feature', () => {
    expect([...INTEGRATION_TYPES]).toStrictEqual(['jira'])
  })

  it('guards membership', () => {
    expect(isIntegrationType('jira')).toBe(true)
    expect(isIntegrationType('github')).toBe(false)
  })
})
