import { describe, expect, it } from 'vitest'

import type { NotificationStore } from './notification-store'
import {
  createFakeNotificationStore,
  fakeAudienceMember,
  fakeSubject,
} from './notification-store-fake'

/**
 * The fake must be the interface and no more. A fake with a wider surface than
 * {@link NotificationStore} would let a delivery path that had grown one pass its tests, which is
 * the FR-141 regression the narrow interface exists to prevent.
 */
describe('createFakeNotificationStore', () => {
  it('implements the store and nothing beyond it plus its own recorders', () => {
    const store: NotificationStore = createFakeNotificationStore()

    expect(Object.keys(store).sort()).toStrictEqual([
      'readAudience',
      'readAudienceByUser',
      'readRecentDeliveries',
      'readSubject',
      'recordAttempt',
      'recorded',
      'setAudience',
      'setRecentDeliveries',
    ])
  })

  it('records attempts in order with the defaults the real store applies', async () => {
    const store = createFakeNotificationStore()

    await store.recordAttempt({
      workflowId: 'w1',
      recipientUserId: 'ada',
      event: 'workflow_succeeded',
      outcome: 'delivered',
    })
    await store.recordAttempt({
      workflowId: null,
      recipientUserId: 'ada',
      event: 'integration_tick_summary',
      outcome: 'failed',
      coalescedCount: 4,
      error: 'boom',
    })

    expect(store.recorded.map((row) => row.outcome)).toStrictEqual(['delivered', 'failed'])
    expect(store.recorded[0]?.coalescedCount).toBe(1)
    expect(store.recorded[0]?.error).toBeNull()
    expect(store.recorded[1]?.workflowId).toBeNull()
  })

  it('answers readSubject with the workflow it was asked about', async () => {
    const store = createFakeNotificationStore({ subject: fakeSubject() })

    await expect(store.readSubject('w9')).resolves.toMatchObject({ workflowId: 'w9' })
  })

  it('answers with nothing when no subject was configured', async () => {
    await expect(createFakeNotificationStore().readSubject('w1')).resolves.toBeUndefined()
  })

  it('lets the audience change mid-test', async () => {
    const store = createFakeNotificationStore({
      audience: [fakeAudienceMember({ userId: 'ada' })],
    })

    store.setAudience([fakeAudienceMember({ userId: 'grace' })])

    const audience = await store.readAudience({ workflowId: 'w1', event: 'workflow_succeeded' })
    expect(audience.map((member) => member.userId)).toStrictEqual(['grace'])
  })

  it('filters readAudienceByUser to the ids asked for', async () => {
    const store = createFakeNotificationStore({
      audience: [fakeAudienceMember({ userId: 'ada' }), fakeAudienceMember({ userId: 'grace' })],
    })

    const audience = await store.readAudienceByUser({
      userIds: ['grace'],
      event: 'integration_tick_summary',
    })
    expect(audience.map((member) => member.userId)).toStrictEqual(['grace'])
  })

  it('applies the window to recent deliveries the way the real store does', async () => {
    const now = Date.now()
    const store = createFakeNotificationStore({
      recentDeliveries: [
        { recipientUserId: 'ada', deliveredAt: new Date(now - 1_000) },
        { recipientUserId: 'grace', deliveredAt: new Date(now - 90_000) },
      ],
    })

    const recent = await store.readRecentDeliveries({
      workflowId: 'w1',
      since: new Date(now - 45_000),
    })

    expect(recent.map((delivery) => delivery.recipientUserId)).toStrictEqual(['ada'])
  })

  it('builds an audience member that is enabled and notifiable by default', () => {
    expect(fakeAudienceMember({ userId: 'ada' })).toStrictEqual({
      userId: 'ada',
      displayName: 'User ada',
      slackUserId: 'slack-ada',
      isActive: true,
      relation: 'owner',
      preferenceEnabled: null,
    })
  })
})
