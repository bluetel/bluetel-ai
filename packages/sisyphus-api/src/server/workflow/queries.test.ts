/* cspell:ignore ungranted */
import { randomUUID } from 'node:crypto'

import { TRPCError } from '@trpc/server'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { SisyphusDatabase } from '../../db'
import { workflowWatchers } from '../../db'
import { listWorkflowsInput, spendSummaryInput } from '../../schemas'
import type { SisyphusContext } from '../context'
import { createCallerFactory } from '../procedures'
import type { ResolvedScope } from '../scope'

import {
  countVisibleWorkflows,
  listWorkflows,
  readArtifacts,
  readLogSegments,
  readTimeline,
  readWorkflowDetail,
  summariseSpend,
} from './queries'
import { workflowRouter } from './router'
import type { TwoProfileFixture, TwoProfileIds } from './test-support'
import {
  createTwoProfileFixture,
  readTestDatabaseUrl,
  refusalOf,
  SPEND_A,
  SPEND_B,
} from './test-support'
import { unwatchWorkflow, watchWorkflow } from './watch'

/**
 * **The leak contract (T042).** Quickstart scenario 1f, expressed as a test.
 *
 * Two users, two execution profiles, two complete and disjoint worlds. Every read path the panel
 * has — the list, **every** filter on it, search, the counts and the spend aggregate, plus the
 * four id-taking reads — is exercised twice: once to prove the granted user *can* see their own
 * run through it, and once to prove the same path says nothing about the run they were not
 * granted. FR-190 forbids disclosing a workflow **including its existence**, so "says nothing"
 * means no row, no count, no penny of spend, and no error that differs from the one a nonexistent
 * id produces.
 *
 * ## Why every assertion is a pair
 *
 * A leak test that only asserted absence passes trivially against a base selector broken to return
 * nothing — and a selector that returns nothing is not secure, it is broken, and it would ship. So
 * each negative is preceded by the positive that would fail first. Both mutations of the base
 * selector are therefore caught: `always true` fails the negatives, `always false` fails the
 * positives.
 *
 * ## The rule that is easiest to get wrong
 *
 * Out of scope is `NOT_FOUND`, **never** `FORBIDDEN`. `FORBIDDEN` answers "does this workflow
 * exist?" with yes, which is the disclosure. And the refusal for an out-of-scope id must be
 * identical — code **and message** — to the refusal for an id that never existed, or the
 * difference is an oracle for enumerating workflow ids. Both are asserted below, explicitly,
 * rather than left to review.
 *
 * Skipped — not failed — when `SISYPHUS_TEST_DATABASE_URL` is absent, so a plain `vitest run` on a
 * machine with no Postgres stays green.
 */

const connectionString = readTestDatabaseUrl()

describe.skipIf(connectionString === undefined)('workflow read paths are scoped (FR-190)', () => {
  let fixture: TwoProfileFixture
  let db: SisyphusDatabase
  let ids: TwoProfileIds

  let aliceScope: ResolvedScope
  let bobScope: ResolvedScope
  let outsiderScope: ResolvedScope
  let adminScope: ResolvedScope

  beforeAll(async () => {
    fixture = createTwoProfileFixture(connectionString ?? '')
    await fixture.open()
    db = fixture.db()
    ids = fixture.ids()

    aliceScope = await fixture.scopeFor(ids.alice)
    bobScope = await fixture.scopeFor(ids.bob)
    outsiderScope = await fixture.scopeFor(ids.outsider)
    adminScope = await fixture.scopeFor(ids.admin, true)
  }, 60_000)

  afterAll(async () => {
    await fixture.close()
  }, 30_000)

  /** Run the list with one filter applied, returning just the ids it matched. */
  const listIds = async (
    scope: ResolvedScope,
    filters: Record<string, unknown> = {},
  ): Promise<readonly string[]> => {
    const input = listWorkflowsInput.parse(filters)
    const page = await listWorkflows({ db, scope, input })
    return page.items.map((item) => item.id)
  }

  describe('the fixture itself', () => {
    it('grants each user exactly one profile, and the outsider none', () => {
      // If this drifts, every "cannot see" assertion below becomes vacuous for a different reason
      // than the one it is testing.
      expect(aliceScope.visibleProfileIds).toStrictEqual([ids.a.executionProfileId])
      expect(bobScope.visibleProfileIds).toStrictEqual([ids.b.executionProfileId])
      expect(outsiderScope.visibleProfileIds).toStrictEqual([])
      expect(adminScope.isAdmin).toBe(true)
    })
  })

  describe('list', () => {
    it('shows each grant holder their own run and not the other', async () => {
      await expect(listIds(aliceScope)).resolves.toStrictEqual([ids.a.workflowId])
      await expect(listIds(bobScope)).resolves.toStrictEqual([ids.b.workflowId])
    })

    it('shows a user granted neither profile nothing at all', async () => {
      await expect(listIds(outsiderScope)).resolves.toStrictEqual([])
    })

    it('shows an admin both, without a grant (FR-181)', async () => {
      const seen = await listIds(adminScope)

      expect(seen).toContain(ids.a.workflowId)
      expect(seen).toContain(ids.b.workflowId)
    })
  })

  /**
   * **Every filter `listWorkflowsInput` accepts.** Each case filters by a value belonging to the
   * *other* world and asserts an empty result — a filter that widened the visible set would show
   * the other user's run here — and then filters by the caller's own value to prove the filter
   * itself works and the empty result above meant something.
   */
  describe('every filter narrows within the scope and never past it', () => {
    const cases: readonly {
      readonly name: string
      readonly mine: (identifiers: TwoProfileIds) => Record<string, unknown>
      readonly theirs: (identifiers: TwoProfileIds) => Record<string, unknown>
    }[] = [
      {
        name: 'initiatedByUserId',
        mine: (i) => ({ initiatedByUserId: i.alice }),
        theirs: (i) => ({ initiatedByUserId: i.bob }),
      },
      {
        name: 'ownerUserId',
        mine: (i) => ({ ownerUserId: i.alice }),
        theirs: (i) => ({ ownerUserId: i.bob }),
      },
      {
        name: 'originatingIntegrationId',
        mine: (i) => ({ originatingIntegrationId: i.a.integrationId }),
        theirs: (i) => ({ originatingIntegrationId: i.b.integrationId }),
      },
      {
        name: 'executionProfileId',
        mine: (i) => ({ executionProfileId: i.a.executionProfileId }),
        theirs: (i) => ({ executionProfileId: i.b.executionProfileId }),
      },
      {
        name: 'workspaceId',
        mine: (i) => ({ workspaceId: i.a.workspaceId }),
        theirs: (i) => ({ workspaceId: i.b.workspaceId }),
      },
      {
        name: 'repositoryUrl',
        mine: (i) => ({ repositoryUrl: i.a.repositoryUrl }),
        theirs: (i) => ({ repositoryUrl: i.b.repositoryUrl }),
      },
      {
        name: 'search',
        mine: (i) => ({ search: i.a.ticketReference }),
        theirs: (i) => ({ search: i.b.ticketReference }),
      },
    ]

    for (const scenario of cases) {
      it(`${scenario.name}: matches the caller's own run`, async () => {
        await expect(listIds(aliceScope, scenario.mine(ids))).resolves.toStrictEqual([
          ids.a.workflowId,
        ])
      })

      it(`${scenario.name}: reveals nothing about the ungranted profile`, async () => {
        await expect(listIds(aliceScope, scenario.theirs(ids))).resolves.toStrictEqual([])
      })
    }

    /**
     * The two filters both worlds legitimately share. A filter that matches every seeded row is
     * the sharpest test there is of whether the *scope* is doing the narrowing: if the answer is
     * ever both runs, nothing but the base selector could have let the second one through.
     */
    it('setupBundleId: the shared bundle still yields only the caller’s own run', async () => {
      await expect(listIds(aliceScope, { setupBundleId: ids.bundle })).resolves.toStrictEqual([
        ids.a.workflowId,
      ])
      await expect(listIds(bobScope, { setupBundleId: ids.bundle })).resolves.toStrictEqual([
        ids.b.workflowId,
      ])
    })

    it('type and state: shared values still yield only the caller’s own run', async () => {
      const shared = { type: 'delegated', state: ['running'] }

      await expect(listIds(aliceScope, shared)).resolves.toStrictEqual([ids.a.workflowId])
      await expect(listIds(bobScope, shared)).resolves.toStrictEqual([ids.b.workflowId])
      await expect(listIds(outsiderScope, shared)).resolves.toStrictEqual([])
    })

    it('a wildcard in the search term cannot widen the match', async () => {
      // Unescaped, `%` matches everything — including the run the caller may not see.
      await expect(listIds(aliceScope, { search: '%' })).resolves.toStrictEqual([])
    })
  })

  describe('counts', () => {
    it('counts only what the caller may see — a total discloses existence too (FR-190)', async () => {
      const input = listWorkflowsInput.parse({})

      await expect(countVisibleWorkflows({ db, scope: aliceScope, input })).resolves.toBe(1)
      await expect(countVisibleWorkflows({ db, scope: bobScope, input })).resolves.toBe(1)
      await expect(countVisibleWorkflows({ db, scope: outsiderScope, input })).resolves.toBe(0)
      await expect(countVisibleWorkflows({ db, scope: adminScope, input })).resolves.toBe(2)
    })
  })

  describe('the spend aggregate', () => {
    const summaryFor = async (
      scope: ResolvedScope,
      groupBy: 'client' | 'workspace' | 'profile' | 'user',
    ) => summariseSpend({ db, scope, input: spendSummaryInput.parse({ groupBy }) })

    for (const groupBy of ['client', 'workspace', 'profile', 'user'] as const) {
      it(`grouped by ${groupBy}: totals the caller's own spend and none of the other's`, async () => {
        const mine = await summaryFor(aliceScope, groupBy)

        // Non-vacuous first: the caller's own figure has to be there and be right.
        expect(mine.workflowCount).toBe(1)
        expect(Number(mine.spendTotal)).toBeCloseTo(Number(SPEND_A), 4)
        expect(mine.groups).toHaveLength(1)

        // And then the leak: the other world's spend is nowhere in the number or in the groups.
        expect(Number(mine.spendTotal)).not.toBeCloseTo(Number(SPEND_B), 4)
        expect(Number(mine.spendTotal)).not.toBeCloseTo(Number(SPEND_A) + Number(SPEND_B), 4)
        expect(mine.groups.map((group) => group.groupId)).not.toContain(ids.b.executionProfileId)
        expect(mine.groups.map((group) => group.groupId)).not.toContain(ids.bob)
      })
    }

    it('shows a user granted neither profile a total of zero', async () => {
      const summary = await summaryFor(outsiderScope, 'profile')

      expect(summary.groups).toStrictEqual([])
      expect(summary.workflowCount).toBe(0)
      expect(Number(summary.spendTotal)).toBe(0)
    })

    it('sums both worlds for an admin, which is what proves the zero above is a scope decision', async () => {
      const summary = await summaryFor(adminScope, 'profile')

      expect(summary.workflowCount).toBe(2)
      expect(Number(summary.spendTotal)).toBeCloseTo(Number(SPEND_A) + Number(SPEND_B), 4)
    })
  })

  describe('the id-taking reads', () => {
    it('let the grant holder read their own run through every one of them', async () => {
      const workflowId = ids.a.workflowId

      await expect(
        readWorkflowDetail({ db, scope: aliceScope, workflowId }),
      ).resolves.toMatchObject({ workflow: { id: workflowId } })
      await expect(readTimeline({ db, scope: aliceScope, workflowId })).resolves.toHaveLength(1)
      await expect(
        readLogSegments({ db, scope: aliceScope, workflowId, fromSequence: 0 }),
      ).resolves.toHaveLength(1)
      await expect(readArtifacts({ db, scope: aliceScope, workflowId })).resolves.toHaveLength(1)
    })

    it('refuse the ungranted run with NOT_FOUND — never FORBIDDEN (FR-190)', async () => {
      const workflowId = ids.b.workflowId

      const refusals = [
        await refusalOf(() => readWorkflowDetail({ db, scope: aliceScope, workflowId })),
        await refusalOf(() => readTimeline({ db, scope: aliceScope, workflowId })),
        await refusalOf(() =>
          readLogSegments({ db, scope: aliceScope, workflowId, fromSequence: 0 }),
        ),
        await refusalOf(() => readArtifacts({ db, scope: aliceScope, workflowId })),
      ]

      for (const refusal of refusals) {
        expect(refusal).toBeInstanceOf(TRPCError)
        expect(refusal.code).toBe('NOT_FOUND')
        // Stated separately and deliberately: FORBIDDEN is the intuitive code and it is a
        // disclosure, because it answers "does this workflow exist?" with yes.
        expect(refusal.code).not.toBe('FORBIDDEN')
      }
    })

    it('are indistinguishable from a workflow that never existed — code and message', async () => {
      const nonexistent = randomUUID()

      const paths = [
        (workflowId: string) => readWorkflowDetail({ db, scope: aliceScope, workflowId }),
        (workflowId: string) => readTimeline({ db, scope: aliceScope, workflowId }),
        (workflowId: string) =>
          readLogSegments({ db, scope: aliceScope, workflowId, fromSequence: 0 }),
        (workflowId: string) => readArtifacts({ db, scope: aliceScope, workflowId }),
      ]

      for (const path of paths) {
        const outOfScope = await refusalOf(() => path(ids.b.workflowId))
        const missing = await refusalOf(() => path(nonexistent))

        // If these ever differ — in code, in message, in anything the caller can observe — the
        // difference is an oracle for enumerating workflow ids.
        expect(outOfScope.code).toBe(missing.code)
        expect(outOfScope.message).toBe(missing.message)
      }
    })

    it('does not leak the other run’s log even by segment count', async () => {
      // Reading from a sequence that exists in the other world must still refuse, rather than
      // returning an empty array that would say "the run exists but has no output from here".
      const refusal = await refusalOf(() =>
        readLogSegments({ db, scope: aliceScope, workflowId: ids.b.workflowId, fromSequence: 0 }),
      )

      expect(refusal.code).toBe('NOT_FOUND')
    })
  })

  /**
   * `watching` on the detail read (FR-138, FR-190).
   *
   * The Watch/Unwatch control lives on the workflow detail view, and until this field existed the
   * panel had no way to know which of the two to render. It rides on `byId` rather than on a
   * procedure of its own so that the answer is only ever computed for an id
   * `requireWorkflowInScope` has already admitted — the argument is in `./queries.ts`, and these
   * are the assertions behind it.
   */
  describe('whether the caller is watching (FR-138)', () => {
    it('is false for a run the caller may see but does not follow', async () => {
      const detail = await readWorkflowDetail({
        db,
        scope: aliceScope,
        workflowId: ids.a.workflowId,
      })

      expect(detail.watching).toBe(false)
    })

    it('becomes true once the caller watches it, and stays scoped to them', async () => {
      await watchWorkflow({
        db,
        scope: aliceScope,
        userId: ids.alice,
        workflowId: ids.a.workflowId,
      })

      const mine = await readWorkflowDetail({ db, scope: aliceScope, workflowId: ids.a.workflowId })
      expect(mine.watching).toBe(true)

      // The admin can see the same run and is not watching it. A field that reported "somebody is
      // watching this" rather than "you are" would be a different — and wrong — sentence.
      const theirs = await readWorkflowDetail({
        db,
        scope: adminScope,
        workflowId: ids.a.workflowId,
      })
      expect(theirs.watching).toBe(false)
    })

    it('goes back to false on unwatch', async () => {
      await unwatchWorkflow({
        db,
        scope: aliceScope,
        userId: ids.alice,
        workflowId: ids.a.workflowId,
      })

      const detail = await readWorkflowDetail({
        db,
        scope: aliceScope,
        workflowId: ids.a.workflowId,
      })
      expect(detail.watching).toBe(false)
    })

    it('cannot be used to confirm an out-of-scope run exists — even watched (FR-190)', async () => {
      // The strongest case for putting this on `byId`: the watcher row is inserted behind the
      // scope check's back, so if the field were served by an unscoped read it would answer `true`
      // for a run the caller may not see, which is the disclosure FR-190 forbids.
      await db
        .insert(workflowWatchers)
        .values({ workflowId: ids.b.workflowId, userId: ids.alice })
        .onConflictDoNothing()

      const outOfScope = await refusalOf(() =>
        readWorkflowDetail({ db, scope: aliceScope, workflowId: ids.b.workflowId }),
      )
      const missing = await refusalOf(() =>
        readWorkflowDetail({ db, scope: aliceScope, workflowId: randomUUID() }),
      )

      expect(outOfScope.code).toBe('NOT_FOUND')
      expect(outOfScope.message).toBe(missing.message)

      await db
        .delete(workflowWatchers)
        .where(
          and(
            eq(workflowWatchers.workflowId, ids.b.workflowId),
            eq(workflowWatchers.userId, ids.alice),
          ),
        )
    })
  })

  /**
   * The same rules through the real procedures, not only through the helpers — because a resolver
   * that forgot to pass `ctx.scope` would pass every test above.
   */
  describe('through the mounted router', () => {
    const callerFor = (userId: string, scope: ResolvedScope) => {
      const session = {
        user: {
          id: userId,
          email: `caller-${userId}@sisyphus.test`,
          displayName: 'Caller',
          role: 'engineer' as const,
          isActive: true,
        },
        expiresAt: new Date(Date.now() + 60_000),
      }

      const context: SisyphusContext = {
        headers: new Headers(),
        dependencies: {
          db,
          resolveSession: () => Promise.resolve(session),
          resolveMachineCredential: () => Promise.resolve(null),
          recordDenial: () => Promise.resolve(),
        },
        db,
        session,
        scope: { resolve: () => Promise.resolve(scope) },
        machineCredential: () => Promise.resolve(null),
      }

      return createCallerFactory(workflowRouter)(context)
    }

    it('list, byId and spendSummary all stop at the scope boundary', async () => {
      const alice = callerFor(ids.alice, aliceScope)

      const page = await alice.list({ limit: 50 })
      expect(page.items.map((item) => item.id)).toStrictEqual([ids.a.workflowId])

      await expect(alice.byId({ workflowId: ids.a.workflowId })).resolves.toMatchObject({
        workflow: { id: ids.a.workflowId },
      })
      await expect(alice.byId({ workflowId: ids.b.workflowId })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })

      const summary = await alice.spendSummary({ groupBy: 'profile' })
      expect(Number(summary.spendTotal)).toBeCloseTo(Number(SPEND_A), 4)
    })

    it('answers a user granted neither profile with an empty list, not an error', async () => {
      const outsider = callerFor(ids.outsider, outsiderScope)

      const page = await outsider.list({ limit: 50 })
      expect(page.items).toStrictEqual([])
      expect(page.nextCursor).toBeUndefined()
    })
  })
})
