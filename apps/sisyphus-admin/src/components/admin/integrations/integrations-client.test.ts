import { describe, expect, it } from 'vitest'

import {
  createUnavailableIntegrationsClient,
  INTEGRATIONS_UNAVAILABLE,
} from './integrations-client'

describe('createUnavailableIntegrationsClient (T121)', () => {
  const client = createUnavailableIntegrationsClient()

  it.each([
    'list',
    'create',
    'update',
    'setEnabled',
    'validate',
    'runNow',
    'previewPrompt',
  ] as const)('refuses %s rather than answering with nothing', async (method) => {
    await expect((client[method] as (input?: unknown) => Promise<unknown>)({})).rejects.toThrow(
      INTEGRATIONS_UNAVAILABLE,
    )
  })

  it('says the API is not mounted, not that there are no integrations', () => {
    // An admin looking at a list of zero would conclude none are configured, which is a different
    // and worse statement than "this deployment cannot answer".
    expect(INTEGRATIONS_UNAVAILABLE).toContain('not mounted')
  })

  it('covers every method the panel calls, so a missing one is a compile error not a crash', () => {
    expect(Object.keys(client).sort()).toStrictEqual([
      'create',
      'list',
      'previewPrompt',
      'runNow',
      'setEnabled',
      'update',
      'validate',
    ])
  })
})
