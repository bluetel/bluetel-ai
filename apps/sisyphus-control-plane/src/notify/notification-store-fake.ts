import type { Notification } from '@bluetel-ai/sisyphus-api/db'

import type {
  AudienceMember,
  NotificationAttempt,
  NotificationStore,
  NotificationSubject,
  RecentDelivery,
} from './notification-store'

/**
 * Recording fake for {@link NotificationStore}.
 *
 * It records every appended attempt in order, which is what the coalescing assertions are written
 * against — "four transitions, one row with `coalescedCount: 4`" is a statement about a sequence,
 * and a fake that only kept the latest could not express it.
 *
 * Like the store it stands in for, it has **no way to alter a workflow**. That is not an omission
 * for brevity: a fake with a wider surface than the interface would let a test pass against a
 * delivery path that had grown one, which is the regression FR-141 is about.
 */

export interface FakeNotificationStoreOptions {
  readonly subject?: NotificationSubject
  readonly audience?: readonly AudienceMember[]
  readonly recentDeliveries?: readonly RecentDelivery[]
}

export interface FakeNotificationStore extends NotificationStore {
  /** Every attempt appended, oldest first. */
  readonly recorded: readonly Notification[]
  /** Replace the audience mid-test, for a preference change between deliveries. */
  readonly setAudience: (audience: readonly AudienceMember[]) => void
  /** Replace the recent-delivery history, for driving the coalescing window. */
  readonly setRecentDeliveries: (deliveries: readonly RecentDelivery[]) => void
}

/** A plain audience member, so a test names only the field it is about. */
export const fakeAudienceMember = (
  overrides: Partial<AudienceMember> & { readonly userId: string },
): AudienceMember => ({
  displayName: `User ${overrides.userId}`,
  slackUserId: `slack-${overrides.userId}`,
  isActive: true,
  relation: 'owner',
  preferenceEnabled: null,
  ...overrides,
})

/** A plain subject, likewise. */
export const fakeSubject = (overrides: Partial<NotificationSubject> = {}): NotificationSubject => ({
  workflowId: '00000000-0000-7000-8000-000000000001',
  state: 'succeeded',
  terminalOutcome: 'succeeded',
  outcomeReason: null,
  ticketReference: 'ABC-1',
  workspaceName: 'Payments',
  integrationName: null,
  ownerUserId: 'owner',
  turnsUsed: 4,
  turnCap: 40,
  spendUsed: '3.5000',
  spendCap: '25.0000',
  ...overrides,
})

export const createFakeNotificationStore = (
  options: FakeNotificationStoreOptions = {},
): FakeNotificationStore => {
  const recorded: Notification[] = []
  let audience = options.audience ?? []
  let recentDeliveries = options.recentDeliveries ?? []

  return {
    recorded,

    setAudience: (next) => {
      audience = next
    },

    setRecentDeliveries: (next) => {
      recentDeliveries = next
    },

    readSubject: (workflowId) =>
      Promise.resolve(
        options.subject === undefined ? undefined : { ...options.subject, workflowId },
      ),

    // Neither narrows by event: the audience a test sets is already the one for the event under
    // test. The real store's left join is what applies the event, and `recipients.test.ts` covers
    // the preference rule directly rather than through this fake.
    readAudience: () => Promise.resolve(audience),

    readAudienceByUser: ({ userIds }) =>
      Promise.resolve(audience.filter((row) => userIds.includes(row.userId))),

    readRecentDeliveries: ({ since }) =>
      Promise.resolve(
        recentDeliveries.filter((row) => row.deliveredAt.getTime() >= since.getTime()),
      ),

    recordAttempt: (attempt: NotificationAttempt) => {
      const row: Notification = {
        id: `notification-${recorded.length + 1}`,
        workflowId: attempt.workflowId,
        recipientUserId: attempt.recipientUserId,
        event: attempt.event,
        channel: 'slack_dm',
        outcome: attempt.outcome,
        coalescedCount: attempt.coalescedCount ?? 1,
        error: attempt.error ?? null,
        createdAt: new Date(),
      }
      recorded.push(row)
      return Promise.resolve(row)
    },
  }
}
