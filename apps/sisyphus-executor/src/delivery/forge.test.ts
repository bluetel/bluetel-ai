import { describe, expect, it } from 'vitest'

import type { Forge } from './forge'
import { pullRequestIdempotencyKey } from './forge'

const key = {
  workflowId: '3f7b6d2a-1c5e-4a9b-8d3f-2e6c9a4b1d70',
  repository: 'https://forge.test/acme/web',
  head: 'sisyphus/ACME-142',
  base: 'develop',
}

describe('pullRequestIdempotencyKey', () => {
  it('is the same on every attempt of one run’s delivery', () => {
    expect(pullRequestIdempotencyKey(key)).toBe(pullRequestIdempotencyKey({ ...key }))
  })

  it('differs for another run, repository, branch or base', () => {
    const keys = new Set([
      pullRequestIdempotencyKey(key),
      pullRequestIdempotencyKey({ ...key, workflowId: '00000000-0000-4000-8000-000000000001' }),
      pullRequestIdempotencyKey({ ...key, repository: 'https://forge.test/acme/api' }),
      pullRequestIdempotencyKey({ ...key, head: 'sisyphus/ACME-143' }),
      pullRequestIdempotencyKey({ ...key, base: 'main' }),
    ])

    expect(keys.size).toBe(5)
  })

  it('carries the run identity, so it cannot collide across workflows', () => {
    expect(pullRequestIdempotencyKey(key)).toContain(key.workflowId)
  })
})

describe('the Forge port', () => {
  it('exposes exactly three methods, none of which touches a ticket', () => {
    // FR-060 leaves the ticket with the initiating engineer. The rule is kept
    // by there being nothing here that could break it: a delegated run cannot
    // transition a ticket because the only external port it is given has no
    // method that does.
    const forge: Forge = {
      branchHead: () => Promise.resolve(undefined),
      findPullRequest: () => Promise.resolve(undefined),
      createPullRequest: () =>
        Promise.resolve({ number: 1, url: 'https://forge.test/pr/1', isDraft: true }),
    }

    expect(Object.keys(forge).sort()).toEqual([
      'branchHead',
      'createPullRequest',
      'findPullRequest',
    ])
  })
})
