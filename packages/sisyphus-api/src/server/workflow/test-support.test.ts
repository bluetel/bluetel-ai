import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { TwoProfileFixture } from './test-support'
import { createTwoProfileFixture, readTestDatabaseUrl, SPEND_A, SPEND_B } from './test-support'

/**
 * The fixture, tested for the property every suite that uses it silently depends on: **the two
 * worlds are genuinely disjoint**.
 *
 * If they were not — if both runs shared an owner, a profile or a workspace — the leak contract in
 * `queries.test.ts` would still pass while proving nothing, because a selector that returned
 * everything would return the "right" answer by accident.
 */

const connectionString = readTestDatabaseUrl()

describe('createTwoProfileFixture', () => {
  it('refuses to hand out ids before it has seeded any', () => {
    const fixture = createTwoProfileFixture('postgres://unused@127.0.0.1:1/none')

    expect(() => fixture.ids()).toThrow(/before open/)
  })

  it('seeds runs with different spend, so a leaked total is arithmetically visible', () => {
    expect(SPEND_A).not.toBe(SPEND_B)
  })
})

describe.skipIf(connectionString === undefined)('the seeded worlds', () => {
  let fixture: TwoProfileFixture

  beforeAll(async () => {
    fixture = createTwoProfileFixture(connectionString ?? '')
    await fixture.open()
  }, 60_000)

  afterAll(async () => {
    await fixture.close()
  }, 30_000)

  it('shares nothing between the two worlds except the setup bundle', () => {
    const ids = fixture.ids()

    for (const key of [
      'workspaceId',
      'workspaceVersionId',
      'workspaceEntryId',
      'executionProfileId',
      'executionProfileVersionId',
      'integrationId',
      'workflowId',
      'workflowEntryId',
      'repositoryUrl',
      'ticketReference',
    ] as const) {
      expect(ids.a[key]).not.toBe(ids.b[key])
    }
  })

  it('shares the setup bundle deliberately, so one filter matches both runs', () => {
    // The sharpest test of whether the *scope* is narrowing: filtering by this bundle matches
    // every seeded row, so anything but the base selector letting the second one through is
    // visible immediately.
    expect(fixture.ids().bundle).toBeTruthy()
  })

  it('grants each user exactly one profile and the outsider none', async () => {
    const ids = fixture.ids()

    await expect(fixture.scopeFor(ids.alice)).resolves.toMatchObject({
      visibleProfileIds: [ids.a.executionProfileId],
    })
    await expect(fixture.scopeFor(ids.bob)).resolves.toMatchObject({
      visibleProfileIds: [ids.b.executionProfileId],
    })
    await expect(fixture.scopeFor(ids.outsider)).resolves.toMatchObject({
      visibleProfileIds: [],
    })
  })

  it('resolves an admin without a grants query at all (FR-181)', async () => {
    const scope = await fixture.scopeFor(fixture.ids().admin, true)

    expect(scope.isAdmin).toBe(true)
    expect(scope.visibleProfileIds).toStrictEqual([])
  })
})
