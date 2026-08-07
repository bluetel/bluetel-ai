import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { NotificationStore } from './notification-store'
import { createNotificationStore } from './notification-store'
import type { NotifyFixtures } from './notify-fixtures'
import { createNotifyFixtures, readTestDatabaseUrl } from './notify-fixtures'
import { selectRecipients } from './recipients'

/**
 * The store against a real Postgres, because the two things it must get right are both properties
 * of SQL rather than of TypeScript:
 *
 * 1. the preference join is a **left** join, so a user with no preference row still appears — an
 *    inner join here silently mutes everyone who never opened the screen (FR-138);
 * 2. `notifications` accepts a null `workflow_id`, which is what the FR-139 tick summary needs and
 *    what a `not null` column would have quietly forbidden.
 *
 * Skipped — not failed — when `SISYPHUS_TEST_DATABASE_URL` is absent.
 */

const connectionString = readTestDatabaseUrl()

describe.skipIf(connectionString === undefined)('createNotificationStore', () => {
  let fixture: NotifyFixtures
  let store: NotificationStore
  let ownerUserId: string
  let watcherUserId: string
  let silentUserId: string
  let workflowId: string

  beforeAll(async () => {
    fixture = createNotifyFixtures(connectionString ?? '')
    await fixture.open()
    store = createNotificationStore({ db: fixture.db() })

    ownerUserId = await fixture.seedUser({ label: 'owner' })
    // FR-140's case, seeded as a real account with no Slack identity rather than as an absence.
    watcherUserId = await fixture.seedUser({ label: 'watcher', slackUserId: null })
    silentUserId = await fixture.seedUser({ label: 'silent' })

    workflowId = await fixture.seedWorkflow({
      ownerUserId,
      state: 'succeeded',
      ticketReference: 'PAY-9',
    })
    await fixture.addWatcher({ workflowId, userId: watcherUserId })
    await fixture.addWatcher({ workflowId, userId: silentUserId })
    await fixture.setPreference({
      userId: silentUserId,
      event: 'workflow_succeeded',
      enabled: false,
    })
  }, 60_000)

  afterAll(async () => {
    await fixture.close()
  }, 30_000)

  describe('readSubject', () => {
    it('reads everything FR-137 requires the message to state', async () => {
      const subject = await store.readSubject(workflowId)

      expect(subject).toMatchObject({
        workflowId,
        state: 'succeeded',
        terminalOutcome: 'succeeded',
        ticketReference: 'PAY-9',
        workspaceName: fixture.workspaceName,
        ownerUserId,
        turnsUsed: 4,
        turnCap: 40,
        spendUsed: '3.5000',
      })
    })

    it('answers with nothing for a workflow that does not exist', async () => {
      await expect(
        store.readSubject('00000000-0000-7000-8000-000000000000'),
      ).resolves.toBeUndefined()
    })
  })

  describe('readAudience', () => {
    it('returns the owner and every watcher, preference row or not (FR-138)', async () => {
      const audience = await store.readAudience({ workflowId, event: 'workflow_succeeded' })

      expect(audience).toHaveLength(3)
      expect(audience.filter((member) => member.relation === 'owner')).toHaveLength(1)

      // The left join's whole purpose: two of these three have no row, and `null` means enabled.
      const owner = audience.find((member) => member.userId === ownerUserId)
      expect(owner?.preferenceEnabled).toBeNull()

      const silent = audience.find((member) => member.userId === silentUserId)
      expect(silent?.preferenceEnabled).toBe(false)
    })

    it('reports the unnotifiable watcher as present with no Slack id (FR-140)', async () => {
      const audience = await store.readAudience({ workflowId, event: 'workflow_succeeded' })
      const watcher = audience.find((member) => member.userId === watcherUserId)

      expect(watcher?.slackUserId).toBeNull()
      expect(watcher?.relation).toBe('watcher')
    })

    it('composes with selectRecipients to drop only the opt-out', async () => {
      const chosen = selectRecipients(
        await store.readAudience({ workflowId, event: 'workflow_succeeded' }),
      )

      expect(chosen.map((person) => person.userId).sort()).toStrictEqual(
        [ownerUserId, watcherUserId].sort(),
      )
    })

    it('does not apply one event preference to another', async () => {
      const audience = await store.readAudience({ workflowId, event: 'workflow_failed' })
      const silent = audience.find((member) => member.userId === silentUserId)

      // The opt-out was for `workflow_succeeded`. A join that ignored the event would mute this.
      expect(silent?.preferenceEnabled).toBeNull()
    })
  })

  describe('readAudienceByUser', () => {
    it('reads a named set, with their preferences, for the workflow-less summary', async () => {
      const audience = await store.readAudienceByUser({
        userIds: [ownerUserId, silentUserId],
        event: 'workflow_succeeded',
      })

      expect(audience).toHaveLength(2)
      expect(audience.find((member) => member.userId === silentUserId)?.preferenceEnabled).toBe(
        false,
      )
    })

    it('reads nothing for an empty list rather than every user in the platform', async () => {
      await expect(
        store.readAudienceByUser({ userIds: [], event: 'workflow_succeeded' }),
      ).resolves.toStrictEqual([])
    })
  })

  describe('recordAttempt', () => {
    it('appends a delivered attempt with the coalesced count (FR-141)', async () => {
      const row = await store.recordAttempt({
        workflowId,
        recipientUserId: ownerUserId,
        event: 'workflow_succeeded',
        outcome: 'delivered',
        coalescedCount: 3,
      })

      expect(row).toMatchObject({
        workflowId,
        recipientUserId: ownerUserId,
        channel: 'slack_dm',
        outcome: 'delivered',
        coalescedCount: 3,
        error: null,
      })
    })

    it('accepts a null workflow, which is what the tick summary needs (FR-139)', async () => {
      const row = await store.recordAttempt({
        workflowId: null,
        recipientUserId: ownerUserId,
        event: 'integration_tick_summary',
        outcome: 'delivered',
        coalescedCount: 12,
      })

      expect(row.workflowId).toBeNull()
    })

    it('records an unnotifiable recipient with the reason (FR-140)', async () => {
      const row = await store.recordAttempt({
        workflowId,
        recipientUserId: watcherUserId,
        event: 'workflow_succeeded',
        outcome: 'unnotifiable',
        error: 'The user has no resolvable Slack identity.',
      })

      expect(row.outcome).toBe('unnotifiable')
      expect(row.coalescedCount).toBe(1)
    })
  })

  describe('readRecentDeliveries', () => {
    it('returns only delivered attempts inside the window', async () => {
      const since = new Date(Date.now() - 60_000)
      const recent = await store.readRecentDeliveries({ workflowId, since })

      // The `unnotifiable` row above is not a delivery, so the window must not count it: doing so
      // would suppress the next real message for someone who was never actually messaged.
      expect(recent).toHaveLength(1)
      expect(recent[0]?.recipientUserId).toBe(ownerUserId)
    })

    it('returns nothing once the window has moved past them', async () => {
      await expect(
        store.readRecentDeliveries({ workflowId, since: new Date(Date.now() + 60_000) }),
      ).resolves.toStrictEqual([])
    })
  })
})
