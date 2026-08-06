import { describe, expectTypeOf, it } from 'vitest'

import type { JiraRestClient } from './client'

describe('JiraRestClient', () => {
  it('exposes exactly the four operations the connector needs', () => {
    expectTypeOf<keyof JiraRestClient>().toEqualTypeOf<
      'currentUser' | 'searchIssues' | 'listComments' | 'addComment'
    >()
  })

  it('has no way to transition an issue', () => {
    // FR-057: which transition to apply is skill-defined per client and performed by the executor.
    // The connector only comments. Enforced by absence rather than by convention, so a future
    // change that needs one has to widen the port deliberately.
    expectTypeOf<JiraRestClient>().not.toExtend<{ transitionIssue: unknown }>()
    expectTypeOf<JiraRestClient>().not.toExtend<{ updateIssue: unknown }>()
    expectTypeOf<JiraRestClient>().not.toExtend<{ assignIssue: unknown }>()
  })

  it('never carries the credential in its call shapes', () => {
    // FR-072: the credential is held by the implementation, obtained at call time. Nothing that
    // travels through this interface can be logged with a token in it, because none of these
    // shapes has anywhere to put one.
    expectTypeOf<Parameters<JiraRestClient['searchIssues']>[0]>().toEqualTypeOf<{
      readonly jql: string
      readonly startAt: number
      readonly maxResults: number
    }>()
    expectTypeOf<Parameters<JiraRestClient['currentUser']>>().toEqualTypeOf<[]>()
  })
})
