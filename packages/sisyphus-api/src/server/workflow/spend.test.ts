import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { SisyphusDatabase } from '../../db'
import { workflows } from '../../db'
import { spendSummaryInput } from '../../schemas'
import type { ResolvedScope } from '../scope'

import { summariseSpend } from './queries'
import type { SpendGrouping } from './spend'
import {
  attributeSpend,
  COLLECTIVE_SPEND_GROUPINGS,
  defaultSpendGrouping,
  INDIVIDUAL_SPEND_GROUPING,
  isIndividualGrouping,
} from './spend'
import type { TwoProfileFixture, TwoProfileIds } from './test-support'
import { createTwoProfileFixture, readTestDatabaseUrl, SPEND_A, SPEND_B } from './test-support'

/**
 * **FR-156, on top of T042's leak contract.**
 *
 * The scoping half is `queries.test.ts`'s: `attributeSpend` issues no statement of its own, so a
 * scope assertion here would be asserting on `summariseSpend`. What it *does* add is the part of
 * FR-156 that scoping cannot cover — the default that is not per-individual, the narrowing of an
 * individual grouping to the one person entitled to see it, and the ordering that stops the result
 * being a league table.
 *
 * The scope assertions are still made, over the same two-profile fixture, because the composition
 * is exactly where a leak would be reintroduced: a policy layer that filtered and then re-queried,
 * or that folded a total from something wider than the rows it kept, would pass every assertion in
 * `queries.test.ts` and fail here.
 *
 * ## The third run
 *
 * The fixture seeds one run per world, each owned by the user granted that world's profile. That is
 * enough to prove scope and not enough to prove FR-156, because the only individual inside Alice's
 * scope is Alice. So this suite adds a run **owned by the outsider on profile A** — a colleague's
 * run on a shared profile, which Alice may legitimately see under FR-183. Grouped by profile it is
 * hers to read; grouped by individual it is not.
 *
 * Skipped — not failed — when `SISYPHUS_TEST_DATABASE_URL` is absent.
 */

const connectionString = readTestDatabaseUrl()

/** Spend on the colleague's run. Distinct from both fixture values, so a leak is arithmetic. */
const SPEND_COLLEAGUE = '43.0000'
const TURNS_COLLEAGUE = 5

describe('the default grouping (FR-156)', () => {
  it('is a collective one, read off the schema rather than restated', () => {
    // The assertion FR-156's "default" sentence reduces to. It reads the schema's own default, so
    // moving `spendSummaryInput.groupBy` to `user` fails here rather than passing quietly.
    expect(COLLECTIVE_SPEND_GROUPINGS).toContain(defaultSpendGrouping())
    expect(defaultSpendGrouping()).not.toBe(INDIVIDUAL_SPEND_GROUPING)
  })

  it('classifies exactly one grouping as naming individuals', () => {
    expect(isIndividualGrouping(INDIVIDUAL_SPEND_GROUPING)).toBe(true)
    for (const grouping of COLLECTIVE_SPEND_GROUPINGS) {
      expect(isIndividualGrouping(grouping)).toBe(false)
    }
  })
})

describe.skipIf(connectionString === undefined)('attributed spend (FR-156, FR-190)', () => {
  let fixture: TwoProfileFixture
  let db: SisyphusDatabase
  let ids: TwoProfileIds

  let aliceScope: ResolvedScope
  let outsiderScope: ResolvedScope
  let adminScope: ResolvedScope

  beforeAll(async () => {
    fixture = createTwoProfileFixture(connectionString ?? '')
    await fixture.open()
    db = fixture.db()
    ids = fixture.ids()

    // A colleague's run on Alice's profile: inside her scope by grant (FR-183), and owned by
    // somebody else. Without it the individual grouping has nothing to narrow.
    await db.insert(workflows).values({
      type: 'delegated',
      state: 'running',
      ownerUserId: ids.outsider,
      initiatedByUserId: ids.outsider,
      executionProfileId: ids.a.executionProfileId,
      executionProfileVersionId: ids.a.executionProfileVersionId,
      setupBundleVersionId: ids.bundleVersion,
      workspaceVersionId: ids.a.workspaceVersionId,
      assembledPrompt: 'A colleague’s run on the shared profile.',
      model: 'claude-opus-5',
      instanceType: 'm7i.large',
      purchaseMode: 'spot',
      turnsUsed: TURNS_COLLEAGUE,
      spendUsed: SPEND_COLLEAGUE,
      sessionId: randomUUID(),
    })

    aliceScope = await fixture.scopeFor(ids.alice)
    outsiderScope = await fixture.scopeFor(ids.outsider)
    adminScope = await fixture.scopeFor(ids.admin, true)
  }, 60_000)

  afterAll(async () => {
    await fixture.close()
  }, 30_000)

  const attributedFor = async (scope: ResolvedScope, groupBy: SpendGrouping) =>
    attributeSpend({ db, scope, input: spendSummaryInput.parse({ groupBy }) })

  describe('a collective grouping', () => {
    it('passes the scoped aggregate through unchanged, ranked by spend', async () => {
      // Non-vacuous first: Alice sees her own run and the colleague's, both on her profile.
      const attributed = await attributedFor(aliceScope, 'profile')
      const underlying = await summariseSpend({
        db,
        scope: aliceScope,
        input: spendSummaryInput.parse({ groupBy: 'profile' }),
      })

      expect(attributed.workflowCount).toBe(2)
      expect(Number(attributed.spendTotal)).toBeCloseTo(
        Number(SPEND_A) + Number(SPEND_COLLEAGUE),
        4,
      )
      expect(attributed.ranked).toBe(true)
      expect(attributed.ownRowOnly).toBe(false)

      // And the composition is a composition: nothing is recomputed differently from the mounted
      // aggregate, which is what stops the two disagreeing.
      expect(attributed.groups).toStrictEqual(underlying.groups)
      expect(attributed.spendTotal).toBe(underlying.spendTotal)
    })

    it('discloses nothing of the profile the caller was not granted (FR-190)', async () => {
      for (const grouping of COLLECTIVE_SPEND_GROUPINGS) {
        const attributed = await attributedFor(aliceScope, grouping)

        expect(Number(attributed.spendTotal)).not.toBeCloseTo(Number(SPEND_B), 4)
        expect(attributed.groups.map((group) => group.groupId)).not.toContain(
          ids.b.executionProfileId,
        )
        expect(attributed.groups.map((group) => group.groupId)).not.toContain(ids.b.workspaceId)
      }
    })

    it('shows a caller granted neither profile nothing, and an admin everything', async () => {
      const outsider = await attributedFor(outsiderScope, 'profile')
      const admin = await attributedFor(adminScope, 'profile')

      // The outsider owns the colleague run, so FR-189 gives them that one and nothing else —
      // which is what proves the zero-for-everything-else is a scope decision rather than a bug.
      expect(outsider.workflowCount).toBe(1)
      expect(Number(outsider.spendTotal)).toBeCloseTo(Number(SPEND_COLLEAGUE), 4)

      expect(admin.workflowCount).toBe(3)
      expect(Number(admin.spendTotal)).toBeCloseTo(
        Number(SPEND_A) + Number(SPEND_B) + Number(SPEND_COLLEAGUE),
        4,
      )
    })
  })

  describe('the individual grouping', () => {
    it('gives a non-admin their own row and no colleague’s, on a profile they share', async () => {
      // The leak this narrowing closes is only visible against the aggregate before it, so assert
      // that first: scoping alone would have shown Alice the colleague's per-person total.
      const wholeScope = await summariseSpend({
        db,
        scope: aliceScope,
        input: spendSummaryInput.parse({ groupBy: 'user' }),
      })
      expect(wholeScope.groups.map((group) => group.groupId)).toContain(ids.outsider)

      const attributed = await attributedFor(aliceScope, 'user')

      expect(attributed.groups).toHaveLength(1)
      expect(attributed.groups[0]?.groupId).toBe(ids.alice)
      expect(attributed.ownRowOnly).toBe(true)
    })

    it('folds the total from the rows shown, so the difference cannot be subtracted out', async () => {
      const attributed = await attributedFor(aliceScope, 'user')

      expect(attributed.workflowCount).toBe(1)
      expect(Number(attributed.spendTotal)).toBeCloseTo(Number(SPEND_A), 4)
      // Not the scoped total: that would name the colleague's spend by arithmetic.
      expect(Number(attributed.spendTotal)).not.toBeCloseTo(
        Number(SPEND_A) + Number(SPEND_COLLEAGUE),
        4,
      )
    })

    it('shows an admin every individual, because FR-156 names them', async () => {
      const attributed = await attributedFor(adminScope, 'user')

      expect(attributed.groups.map((group) => group.groupId)).toStrictEqual(
        expect.arrayContaining([ids.alice, ids.bob, ids.outsider]),
      )
      expect(attributed.ownRowOnly).toBe(false)
    })

    it('is never ordered by spend — a ranked list of people is the comparison FR-156 forbids', async () => {
      const attributed = await attributedFor(adminScope, 'user')
      const labels = attributed.groups.map((group) => group.groupLabel ?? '')

      expect(attributed.ranked).toBe(false)
      expect(labels).toStrictEqual([...labels].sort())

      // Non-vacuous: the biggest spender is not first, so this ordering could not also be a
      // spend ranking that happened to agree. Bob spends the most and sorts after Alice.
      const spends = attributed.groups.map((group) => Number(group.spendTotal))
      expect(spends).not.toStrictEqual([...spends].sort((left, right) => right - left))
      expect(Number(SPEND_B)).toBeGreaterThan(Number(SPEND_A))
    })

    it('still discloses no run outside the caller’s scope', async () => {
      const attributed = await attributedFor(aliceScope, 'user')

      expect(attributed.groups.map((group) => group.groupId)).not.toContain(ids.bob)
      expect(Number(attributed.spendTotal)).not.toBeCloseTo(Number(SPEND_B), 4)
    })
  })
})
