import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { SisyphusDatabase } from '../../db'
import { notificationPreferences, users } from '../../db'
import { NOTIFICATION_EVENTS } from '../../enums'
import type { SisyphusContext } from '../context'
import { createCallerFactory } from '../procedures'

import { readNotificationSettings } from './notification-settings'
import { workflowRouter } from './router'
import type { TwoProfileFixture, TwoProfileIds } from './test-support'
import { createTwoProfileFixture, readTestDatabaseUrl } from './test-support'

/**
 * `workflow.notificationSettings` — the caller's own Slack identity and preferences (FR-138,
 * FR-140).
 *
 * Two things are being asserted, and only the first is about data.
 *
 * 1. **The unnotifiable state is reported as a state**, not as a blank field. FR-140 says a user
 *    with no resolvable Slack identity is recorded as unnotifiable and surfaced in the panel; a
 *    read that returned `slackUserId: null` and left the panel to work out what that meant would
 *    satisfy the letter of it and none of the intent.
 * 2. **There is no way to ask about anybody else.** The procedure takes no input, so the assertion
 *    is not "a user id parameter is ignored" — it is that the caller cannot express one at all,
 *    and that two different sessions get two different answers from the same call.
 *
 * Skipped — not failed — when `SISYPHUS_TEST_DATABASE_URL` is absent, so a plain `vitest run` on a
 * machine with no Postgres stays green. In CI the variable is set and the suite runs.
 */

const connectionString = readTestDatabaseUrl()

describe.skipIf(connectionString === undefined)('notification settings', () => {
  let fixture: TwoProfileFixture
  let db: SisyphusDatabase
  let ids: TwoProfileIds

  beforeAll(async () => {
    fixture = createTwoProfileFixture(connectionString ?? '')
    await fixture.open()
    db = fixture.db()
    ids = fixture.ids()
  }, 60_000)

  afterAll(async () => {
    await fixture.close()
  }, 30_000)

  /** A caller with a real session, so the procedure resolves `ctx.user.id` the way it will live. */
  const callerFor = (userId: string) => {
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
      scope: { resolve: () => Promise.resolve({ userId, isAdmin: false, visibleProfileIds: [] }) },
      machineCredential: () => Promise.resolve(null),
      validationCredential: () => Promise.resolve(null),
    }

    return createCallerFactory(workflowRouter)(context)
  }

  describe('the Slack identity (FR-140)', () => {
    it('reports a user with no resolved identity as unnotifiable', async () => {
      // The fixture seeds users with no `slack_user_id`, which is the FR-140 case: the identity
      // did not resolve, and null means no message will ever be delivered.
      const settings = await readNotificationSettings(db, ids.alice)

      expect(settings.slackUserId).toBeNull()
      expect(settings.notifiable).toBe(false)
    })

    it('reports a resolved identity, and says delivery is possible', async () => {
      await db.update(users).set({ slackUserId: 'U0ALICE' }).where(eq(users.id, ids.alice))

      const settings = await readNotificationSettings(db, ids.alice)

      expect(settings.slackUserId).toBe('U0ALICE')
      expect(settings.notifiable).toBe(true)
    })

    it('answers about the user asked for and nobody else', async () => {
      const alice = await readNotificationSettings(db, ids.alice)
      const bob = await readNotificationSettings(db, ids.bob)

      expect(alice.slackUserId).toBe('U0ALICE')
      expect(bob.slackUserId).toBeNull()
    })
  })

  describe('the preferences alongside it (FR-138)', () => {
    it('returns the whole event vocabulary, defaulting to enabled', async () => {
      const settings = await readNotificationSettings(db, ids.bob)

      expect(settings.preferences).toHaveLength(NOTIFICATION_EVENTS.length)
      // Absence of a row means enabled. A settings screen that showed eight muted toggles to
      // somebody who had never opened it would be describing the opposite of what happens.
      expect(settings.preferences.every((preference) => preference.enabled)).toBe(true)
      expect(settings.preferences.every((preference) => !preference.explicit)).toBe(true)
    })

    it('reflects a recorded decision, and marks it as one', async () => {
      await db
        .insert(notificationPreferences)
        .values({ userId: ids.bob, event: 'workflow_succeeded', enabled: false })
        .onConflictDoUpdate({
          target: [notificationPreferences.userId, notificationPreferences.event],
          set: { enabled: false },
        })

      const settings = await readNotificationSettings(db, ids.bob)
      const muted = settings.preferences.find(
        (preference) => preference.event === 'workflow_succeeded',
      )

      expect(muted).toStrictEqual({ event: 'workflow_succeeded', enabled: false, explicit: true })
    })

    it('agrees with workflow.notificationPreferences, because it composes it', async () => {
      // One implementation of "absence of a row means enabled" in this package, not two. If these
      // ever disagree, one of the two reads has grown its own opinion of the default.
      const caller = callerFor(ids.bob)

      const [settings, preferences] = await Promise.all([
        caller.notificationSettings(),
        caller.notificationPreferences(),
      ])

      expect(settings.preferences).toStrictEqual(preferences)
    })
  })

  describe('through the mounted procedure', () => {
    it('answers for the session, with no input to name anyone else', async () => {
      const settings = await callerFor(ids.alice).notificationSettings()

      expect(settings.slackUserId).toBe('U0ALICE')
      expect(settings.notifiable).toBe(true)
    })

    it('gives two sessions two different answers from the same call', async () => {
      // The whole of "only the caller's own identity", stated as behaviour: the call is identical,
      // so the only thing that can be selecting the row is the session.
      const alice = await callerFor(ids.alice).notificationSettings()
      const bob = await callerFor(ids.bob).notificationSettings()

      expect(alice.slackUserId).toBe('U0ALICE')
      expect(bob.slackUserId).toBeNull()
      expect(bob.notifiable).toBe(false)
    })

    it('takes no argument at all, so there is no user id to supply', () => {
      // Asserted on the procedure's shape rather than on a rejected payload: `authedProcedure`
      // with no `.input()` has no parser to reject one with, and that absence *is* the guarantee.
      expect(workflowRouter._def.procedures.notificationSettings._def.inputs).toStrictEqual([])
    })
  })
})
