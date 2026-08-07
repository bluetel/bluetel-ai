import type { IntegrationConnector } from '@bluetel-ai/sisyphus-api/contracts'
import { describe, expect, expectTypeOf, it } from 'vitest'

import type { AssertedJiraConnector, JiraConnector, JiraIntegrationConfig } from './index'
import { createFakeJiraClient, createJiraConnector, createJiraHttpClient } from './index'

describe('the package barrel', () => {
  it('satisfies the connector contract, checked against the inferred implementation', () => {
    // The compile-time half of this assertion is `AssertedJiraConnector` in `./index.ts`: it does
    // not compile if a method drifts from the contract. This is the same claim, restated where a
    // reader looking for it will find it.
    expectTypeOf<ReturnType<typeof createJiraConnector>>().toExtend<JiraConnector>()
    expectTypeOf<AssertedJiraConnector>().toExtend<IntegrationConnector<JiraIntegrationConfig>>()
  })

  it('exports the connector as a factory, so one board’s credential cannot serve another', () => {
    expectTypeOf(createJiraConnector).parameter(0).toExtend<{ client: unknown }>()
    expect(typeof createJiraConnector).toBe('function')
  })

  it('exports the recording fake, so no consumer has to invent a stub', () => {
    expect(typeof createFakeJiraClient).toBe('function')
  })

  it('exports the HTTP adapter, so a deployment needs nothing beyond this package to reach a board', () => {
    expect(typeof createJiraHttpClient).toBe('function')

    // The whole composition, as the registry entry performs it: a client built around one board's
    // credential, and a connector built around that client. Nothing here opens a socket — no method
    // is called — but it is the assignment that has to compile for FR-192's seam to be one entry
    // wide.
    const connector = createJiraConnector({
      client: createJiraHttpClient({
        baseUrl: 'https://acme.atlassian.net',
        credential: 'someone@acme.test:token',
        fetch: () => Promise.reject(new Error('no request is made in this test')),
      }),
    })

    expect(connector.type).toBe('jira')
  })

  it('serves the type the platform vocabulary knows it by', () => {
    expect(createJiraConnector({ client: createFakeJiraClient() }).type).toBe('jira')
  })
})
