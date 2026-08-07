import { randomUUID } from 'node:crypto'

import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { SisyphusDatabase } from '../../db'
import { profileAccessGrants, workflowWatchers } from '../../db'
import { NOTIFICATION_EVENTS } from '../../schemas'
import { findLiveGrant, markGrantRevoked, removeWatchesLeftBehind } from '../admin/grant-store'
import type { ResolvedScope } from '../scope'
import { workflowNotFoundError } from '../scope'

import type { TwoProfileFixture, TwoProfileIds } from './test-support'
import { createTwoProfileFixture, readTestDatabaseUrl, refusalOf } from './test-support'
import {
  applyPreferenceDefaults,
  isWatching,
  readNotificationPreferences,
  readStoredPreferences,
  setNotificationPreference,
  unwatchWorkflow,
  watchWorkflow,
} from './watch'

/**
 * **Watching and preferences (T086).** FR-138, FR-188 and FR-190.
 *
 * The pure half runs everywhere; the live half is skipped — not failed — when
 * `SISYPHUS_TEST_DATABASE_URL` is absent.
 */

/**
 * The rule most easily inverted by an edit, asserted without a database.
 *
 * An implementation that returned only the stored rows, or that defaulted to `false`, passes every
 * "I muted this" test and silently mutes everyone who never opened the screen. So the assertion is
 * about the *empty* input as much as about the populated one.
 */
describe('applyPreferenceDefaults (FR-138)', () => {
  it('treats a user with no rows at all as enabled for every event', () => {
    const effective = applyPreferenceDefaults([])

    expect(effective).toHaveLength(NOTIFICATION_EVENTS.length)
    expect(effective.every((entry) => entry.enabled)).toBe(true)
    expect(effective.every((entry) => !entry.explicit)).toBe(true)
  })

  it('covers the whole vocabulary, in its declared order', () => {
    expect(applyPreferenceDefaults([]).map((entry) => entry.event)).toStrictEqual([
      ...NOTIFICATION_EVENTS,
    ])
  })

  it('applies a stored opt-out to that event and to no other', () => {
    const effective = applyPreferenceDefaults([{ event: 'workflow_failed', enabled: false }])

    const failed = effective.find((entry) => entry.event === 'workflow_failed')
    expect(failed).toStrictEqual({ event: 'workflow_failed', enabled: false, explicit: true })
    expect(effective.filter((entry) => entry.enabled)).toHaveLength(NOTIFICATION_EVENTS.length - 1)
  })

  it('records a stored opt-in as a decision rather than as the default', () => {
    const effective = applyPreferenceDefaults([{ event: 'workflow_succeeded', enabled: true }])

    expect(effective.find((entry) => entry.event === 'workflow_succeeded')).toStrictEqual({
      event: 'workflow_succeeded',
      enabled: true,
      explicit: true,
    })
  })
})

const connectionString = readTestDatabaseUrl()

describe.skipIf(connectionString === undefined)('watch and preferences against a database', () => {
  let fixture: TwoProfileFixture
  let db: SisyphusDatabase
  let ids: TwoProfileIds

  let aliceScope: ResolvedScope
  let bobScope: ResolvedScope
  let outsiderScope: ResolvedScope

  beforeAll(async () => {
    fixture = createTwoProfileFixture(connectionString ?? '')
    await fixture.open()
    db = fixture.db()
    ids = fixture.ids()

    aliceScope = await fixture.scopeFor(ids.alice)
    bobScope = await fixture.scopeFor(ids.bob)
    outsiderScope = await fixture.scopeFor(ids.outsider)
  }, 60_000)

  afterAll(async () => {
    await fixture.close()
  }, 30_000)

  const watcherRows = async (workflowId: string): Promise<readonly string[]> => {
    const rows = await db
      .select({ userId: workflowWatchers.userId })
      .from(workflowWatchers)
      .where(eq(workflowWatchers.workflowId, workflowId))
    return rows.map((row) => row.userId)
  }

  describe('watching a run the caller may see (FR-138)', () => {
    it('creates the watch, and watching twice is one watch', async () => {
      const first = await watchWorkflow({
        db,
        scope: aliceScope,
        userId: ids.alice,
        workflowId: ids.a.workflowId,
      })
      expect(first).toStrictEqual({
        workflowId: ids.a.workflowId,
        watching: true,
        changed: true,
      })

      const again = await watchWorkflow({
        db,
        scope: aliceScope,
        userId: ids.alice,
        workflowId: ids.a.workflowId,
      })
      expect(again.changed).toBe(false)

      await expect(watcherRows(ids.a.workflowId)).resolves.toStrictEqual([ids.alice])
      await expect(
        isWatching(db, { workflowId: ids.a.workflowId, userId: ids.alice }),
      ).resolves.toBe(true)
    })

    it('removes it again, and unwatching twice is not an error', async () => {
      const removed = await unwatchWorkflow({
        db,
        scope: aliceScope,
        userId: ids.alice,
        workflowId: ids.a.workflowId,
      })
      expect(removed).toStrictEqual({
        workflowId: ids.a.workflowId,
        watching: false,
        changed: true,
      })

      const noop = await unwatchWorkflow({
        db,
        scope: aliceScope,
        userId: ids.alice,
        workflowId: ids.a.workflowId,
      })
      expect(noop.changed).toBe(false)
      await expect(watcherRows(ids.a.workflowId)).resolves.toStrictEqual([])
    })
  })

  /**
   * **`watch` is not an existence oracle (FR-190).**
   *
   * Each negative is preceded by the positive that would fail first, so a scope check broken to
   * refuse everything is caught by the same suite that catches one broken to allow everything.
   * The refusal for an out-of-scope run must be identical — code **and** message — to the refusal
   * for an id that never existed, or the difference itself enumerates workflows.
   */
  describe('an out-of-scope target is indistinguishable from a nonexistent one', () => {
    const absent = randomUUID()

    it('refuses a run the caller holds no grant on, with NOT_FOUND and no detail', async () => {
      // Positive first: bob really can watch his own run through this path.
      await expect(
        watchWorkflow({ db, scope: bobScope, userId: ids.bob, workflowId: ids.b.workflowId }),
      ).resolves.toMatchObject({ watching: true })

      const outOfScope = await refusalOf(async () =>
        watchWorkflow({ db, scope: bobScope, userId: ids.bob, workflowId: ids.a.workflowId }),
      )
      const nonexistent = await refusalOf(async () =>
        watchWorkflow({ db, scope: bobScope, userId: ids.bob, workflowId: absent }),
      )

      expect(outOfScope.code).toBe('NOT_FOUND')
      expect(outOfScope.code).toBe(nonexistent.code)
      expect(outOfScope.message).toBe(nonexistent.message)
      expect(outOfScope.message).toBe(workflowNotFoundError().message)
      // Never FORBIDDEN: that answers "does this run exist?" with yes.
      expect(outOfScope.code).not.toBe('FORBIDDEN')

      await unwatchWorkflow({
        db,
        scope: bobScope,
        userId: ids.bob,
        workflowId: ids.b.workflowId,
      })
    })

    it('writes nothing when it refuses, so no constraint error can leak what it withheld', async () => {
      await refusalOf(async () =>
        watchWorkflow({ db, scope: bobScope, userId: ids.bob, workflowId: ids.a.workflowId }),
      )

      await expect(watcherRows(ids.a.workflowId)).resolves.toStrictEqual([])
    })

    it('refuses the same way through unwatch, so the oracle cannot be read backwards', async () => {
      const outOfScope = await refusalOf(async () =>
        unwatchWorkflow({ db, scope: bobScope, userId: ids.bob, workflowId: ids.a.workflowId }),
      )
      const nonexistent = await refusalOf(async () =>
        unwatchWorkflow({ db, scope: bobScope, userId: ids.bob, workflowId: absent }),
      )

      expect(outOfScope.code).toBe('NOT_FOUND')
      expect(outOfScope.message).toBe(nonexistent.message)
    })

    it('refuses a user who holds nothing at all', async () => {
      const refusal = await refusalOf(async () =>
        watchWorkflow({
          db,
          scope: outsiderScope,
          userId: ids.outsider,
          workflowId: ids.a.workflowId,
        }),
      )

      expect(refusal.code).toBe('NOT_FOUND')
    })
  })

  /**
   * **FR-188, from the other side.**
   *
   * `../admin/grant-store.ts` owns the cascade that removes the watch. What is asserted here is
   * that this module does not put it back: after the revocation the workflow is out of the user's
   * scope, so a re-watch is refused exactly as a stranger's would be. There is deliberately no
   * revive path to test — the absence is the feature.
   */
  describe('a revoked grant takes the watch with it, and nothing here restores it', () => {
    it('refuses the re-watch once the grant is gone', async () => {
      // Give bob a live grant on profile A, so he can watch a run he neither owns nor initiated.
      await db.insert(profileAccessGrants).values({
        userId: ids.bob,
        executionProfileId: ids.a.executionProfileId,
        grantedByUserId: ids.admin,
      })

      const grantedScope = await fixture.scopeFor(ids.bob)
      await expect(
        watchWorkflow({
          db,
          scope: grantedScope,
          userId: ids.bob,
          workflowId: ids.a.workflowId,
        }),
      ).resolves.toMatchObject({ changed: true })
      await expect(watcherRows(ids.a.workflowId)).resolves.toStrictEqual([ids.bob])

      // The real cascade, through the real functions.
      const target = { userId: ids.bob, executionProfileId: ids.a.executionProfileId }
      const live = await findLiveGrant(db, target)
      expect(live).toBeDefined()

      const removedWatches = await removeWatchesLeftBehind(db, target)
      await markGrantRevoked(db, {
        grantId: live?.id ?? '',
        revokedByUserId: ids.admin,
        revokedAt: new Date(),
      })

      expect(removedWatches).toBe(1)
      await expect(watcherRows(ids.a.workflowId)).resolves.toStrictEqual([])

      // The next request resolves a scope without the revoked profile, so the run is simply not
      // there any more — same refusal a user who never held it gets.
      const revokedScope = await fixture.scopeFor(ids.bob)
      expect(revokedScope.visibleProfileIds).not.toContain(ids.a.executionProfileId)

      const refusal = await refusalOf(async () =>
        watchWorkflow({
          db,
          scope: revokedScope,
          userId: ids.bob,
          workflowId: ids.a.workflowId,
        }),
      )
      expect(refusal.code).toBe('NOT_FOUND')
      await expect(watcherRows(ids.a.workflowId)).resolves.toStrictEqual([])

      await db
        .delete(profileAccessGrants)
        .where(
          and(
            eq(profileAccessGrants.userId, ids.bob),
            eq(profileAccessGrants.executionProfileId, ids.a.executionProfileId),
          ),
        )
    })

    it('keeps the owner watching their own run, because ownership is not a grant (FR-189)', async () => {
      // Alice owns and initiated workflow A, so her watch is not one the grant was keeping alive.
      await watchWorkflow({
        db,
        scope: aliceScope,
        userId: ids.alice,
        workflowId: ids.a.workflowId,
      })

      const removed = await removeWatchesLeftBehind(db, {
        userId: ids.alice,
        executionProfileId: ids.a.executionProfileId,
      })

      expect(removed).toBe(0)
      await expect(watcherRows(ids.a.workflowId)).resolves.toStrictEqual([ids.alice])

      await unwatchWorkflow({
        db,
        scope: aliceScope,
        userId: ids.alice,
        workflowId: ids.a.workflowId,
      })
    })
  })

  describe('notification preferences (FR-138)', () => {
    it('reports every event as enabled for a user who has never set one', async () => {
      const effective = await readNotificationPreferences(db, ids.outsider)

      expect(effective).toHaveLength(NOTIFICATION_EVENTS.length)
      expect(effective.every((entry) => entry.enabled && !entry.explicit)).toBe(true)
    })

    it('stores an opt-out and leaves every other event alone', async () => {
      await setNotificationPreference(db, {
        userId: ids.alice,
        event: 'workflow_failed',
        enabled: false,
      })

      const effective = await readNotificationPreferences(db, ids.alice)
      const failed = effective.find((entry) => entry.event === 'workflow_failed')

      expect(failed).toStrictEqual({ event: 'workflow_failed', enabled: false, explicit: true })
      expect(effective.filter((entry) => entry.enabled)).toHaveLength(
        NOTIFICATION_EVENTS.length - 1,
      )
    })

    it('updates in place rather than accumulating rows', async () => {
      await setNotificationPreference(db, {
        userId: ids.alice,
        event: 'workflow_failed',
        enabled: true,
      })

      const stored = await readStoredPreferences(db, {
        userIds: [ids.alice],
        event: 'workflow_failed',
      })

      expect(stored).toStrictEqual([{ userId: ids.alice, enabled: true }])
    })

    it('returns only the rows that exist, so one place applies the default', async () => {
      // The delivery path reads this and folds the default itself, rather than there being two
      // implementations of "absence means enabled" that could drift apart.
      const stored = await readStoredPreferences(db, {
        userIds: [ids.alice, ids.bob, ids.outsider],
        event: 'workflow_succeeded',
      })

      expect(stored).toStrictEqual([])
      expect(applyPreferenceDefaults([]).every((entry) => entry.enabled)).toBe(true)
    })

    it('reads nothing for an empty user list without touching the database', async () => {
      await expect(
        readStoredPreferences(db, { userIds: [], event: 'workflow_succeeded' }),
      ).resolves.toStrictEqual([])
    })
  })
})
