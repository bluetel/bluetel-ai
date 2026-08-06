import type { Workflow } from '@bluetel-ai/sisyphus-api/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { COALESCE_WINDOW_MS } from './coalesce'
import { deliverNotification, notifyIntegrationTick, notifyWorkflowEvent } from './delivery'
import type { NotificationStore } from './notification-store'
import { createNotificationStore } from './notification-store'
import {
  createFakeNotificationStore,
  fakeAudienceMember,
  fakeSubject,
} from './notification-store-fake'
import type { NotifyFixtures } from './notify-fixtures'
import { createNotifyFixtures, readTestDatabaseUrl } from './notify-fixtures'
import type { NotificationRecipient } from './recipients'
import { createFakeSlackMessenger } from './slack-fake'

/**
 * **FR-141, from both directions.**
 *
 * The requirement is that a delivery failure never alters the workflow's own state or outcome. The
 * fast suite proves the *behaviour* — an outage produces `failed` rows and no exception — and the
 * live suite proves the *fact*, by reading the whole workflow row before and after a total Slack
 * outage and asserting it is unchanged field for field, `updated_at` included.
 *
 * The structural argument is separate from both and stronger than either: `deliverNotification`
 * takes a `NotificationStore` and a `SlackDirectMessenger`, and neither type has a method that can
 * write a workflow. See `./notification-store.ts`. The tests below are what catches a regression in
 * the *wiring*; the types are what stops the regression being writable.
 *
 * The live half is skipped — not failed — when `SISYPHUS_TEST_DATABASE_URL` is absent.
 */

const panel = { baseUrl: 'https://sisyphus.example.com' }

const recipient = (overrides: Partial<NotificationRecipient> = {}): NotificationRecipient => ({
  userId: 'ada',
  displayName: 'Ada',
  slackUserId: 'slack-ada',
  relation: 'owner',
  notifiable: true,
  ...overrides,
})

describe('deliverNotification records every attempt (FR-141)', () => {
  it('records a delivered attempt and sends exactly one message', async () => {
    const store = createFakeNotificationStore()
    const slack = createFakeSlackMessenger()

    const result = await deliverNotification(
      { store, messenger: slack },
      { workflowId: 'w1', event: 'workflow_succeeded', recipient: recipient(), text: 'done' },
    )

    expect(result.outcome).toBe('delivered')
    expect(slack.sent.map((message) => message.text)).toStrictEqual(['done'])
    expect(store.recorded).toHaveLength(1)
    expect(store.recorded[0]).toMatchObject({
      workflowId: 'w1',
      recipientUserId: 'ada',
      event: 'workflow_succeeded',
      outcome: 'delivered',
      channel: 'slack_dm',
      error: null,
    })
  })

  it('records a user with no Slack identity as unnotifiable, and never calls Slack (FR-140)', async () => {
    const store = createFakeNotificationStore()
    const slack = createFakeSlackMessenger()

    const result = await deliverNotification(
      { store, messenger: slack },
      {
        workflowId: 'w1',
        event: 'workflow_failed',
        recipient: recipient({ slackUserId: null, notifiable: false }),
        text: 'x',
      },
    )

    expect(result.outcome).toBe('unnotifiable')
    expect(slack.opened).toStrictEqual([])
    expect(store.recorded[0]?.error).toContain('no resolvable Slack identity')
  })

  it('records a closed direct message as unnotifiable rather than as a failure (FR-140)', async () => {
    const store = createFakeNotificationStore()
    const slack = createFakeSlackMessenger({ unnotifiable: ['slack-ada'] })

    const result = await deliverNotification(
      { store, messenger: slack },
      { workflowId: 'w1', event: 'workflow_failed', recipient: recipient(), text: 'x' },
    )

    expect(result.outcome).toBe('unnotifiable')
    expect(slack.sent).toStrictEqual([])
    expect(store.recorded[0]?.outcome).toBe('unnotifiable')
  })

  it('records an outage as failed, which is retryable, not as a fact about the person', async () => {
    const store = createFakeNotificationStore()
    const slack = createFakeSlackMessenger({ failure: new Error('ratelimited') })

    const result = await deliverNotification(
      { store, messenger: slack },
      { workflowId: 'w1', event: 'workflow_succeeded', recipient: recipient(), text: 'x' },
    )

    expect(result.outcome).toBe('failed')
    expect(store.recorded[0]?.error).toContain('ratelimited')
  })

  it('never throws, so a delivery cannot take down the job that asked for it', async () => {
    const store = createFakeNotificationStore()
    const slack = createFakeSlackMessenger({ failure: new Error('slack is down') })

    await expect(
      deliverNotification(
        { store, messenger: slack },
        { workflowId: 'w1', event: 'workflow_succeeded', recipient: recipient(), text: 'x' },
      ),
    ).resolves.toMatchObject({ outcome: 'failed' })
  })

  it('records a summary against no workflow at all (FR-139)', async () => {
    const store = createFakeNotificationStore()
    const slack = createFakeSlackMessenger()

    await deliverNotification(
      { store, messenger: slack },
      {
        workflowId: null,
        event: 'integration_tick_summary',
        recipient: recipient(),
        text: 'x',
        coalescedCount: 7,
      },
    )

    expect(store.recorded[0]?.workflowId).toBeNull()
    expect(store.recorded[0]?.coalescedCount).toBe(7)
  })
})

describe('the delivery path cannot reach workflow state (FR-141)', () => {
  it('is handed a store whose whole surface is four reads and one append', () => {
    // The guarantee in one assertion. Nothing here can update `workflows`, because nothing here
    // has a method that could — adding one would be a visible change to `notification-store.ts`.
    const store: NotificationStore = createFakeNotificationStore()

    expect(
      Object.keys(store)
        .filter((key) => key.startsWith('read'))
        .sort(),
    ).toStrictEqual(['readAudience', 'readAudienceByUser', 'readRecentDeliveries', 'readSubject'])
    expect(Object.keys(store)).toContain('recordAttempt')
    expect(Object.keys(store)).not.toContain('update')
    expect(Object.keys(store)).not.toContain('transaction')
  })
})

describe('notifyWorkflowEvent', () => {
  const audience = [
    fakeAudienceMember({ userId: 'ada', relation: 'owner' }),
    fakeAudienceMember({ userId: 'grace', relation: 'watcher' }),
  ]

  it('tells the owner and the watchers (FR-136, FR-138)', async () => {
    const store = createFakeNotificationStore({ subject: fakeSubject(), audience })
    const slack = createFakeSlackMessenger()

    const result = await notifyWorkflowEvent({
      store,
      messenger: slack,
      workflowId: 'w1',
      event: 'workflow_succeeded',
      panel,
    })

    expect(result.deliveries.map((delivery) => delivery.recipientUserId)).toStrictEqual([
      'ada',
      'grace',
    ])
    expect(slack.sent).toHaveLength(2)
    expect(slack.sent[0]?.text).toContain('/workflows/w1')
  })

  it('holds a message for someone already messaged inside the window (FR-139)', async () => {
    const now = new Date()
    const store = createFakeNotificationStore({
      subject: fakeSubject(),
      audience,
      recentDeliveries: [{ recipientUserId: 'ada', deliveredAt: new Date(now.getTime() - 1_000) }],
    })
    const slack = createFakeSlackMessenger()

    const result = await notifyWorkflowEvent({
      store,
      messenger: slack,
      workflowId: 'w1',
      event: 'workflow_succeeded',
      panel,
      now,
    })

    expect(result.deliveries.map((delivery) => delivery.recipientUserId)).toStrictEqual(['grace'])
    expect(result.deferred.map((held) => held.recipientUserId)).toStrictEqual(['ada'])
    expect(result.deferred[0]?.readyAt.getTime()).toBeLessThanOrEqual(
      now.getTime() + COALESCE_WINDOW_MS,
    )
  })

  it('folds a backlog into one message that says how many changes it covers', async () => {
    const now = new Date()
    const store = createFakeNotificationStore({
      subject: fakeSubject(),
      audience: [fakeAudienceMember({ userId: 'ada' })],
    })
    const slack = createFakeSlackMessenger()

    await notifyWorkflowEvent({
      store,
      messenger: slack,
      workflowId: 'w1',
      event: 'workflow_succeeded',
      panel,
      now,
      pending: [
        { event: 'workflow_needs_attention', occurredAt: new Date(now.getTime() - 5_000) },
        { event: 'workflow_succeeded', occurredAt: now },
      ],
    })

    expect(slack.sent).toHaveLength(1)
    expect(slack.sent[0]?.text).toContain('2 changes')
    expect(store.recorded[0]?.coalescedCount).toBe(2)
  })

  it('does nothing at all for a workflow that is gone', async () => {
    const store = createFakeNotificationStore({ audience })
    const slack = createFakeSlackMessenger()

    const result = await notifyWorkflowEvent({
      store,
      messenger: slack,
      workflowId: 'missing',
      event: 'workflow_failed',
      panel,
    })

    expect(result).toStrictEqual({ deliveries: [], deferred: [] })
    expect(store.recorded).toStrictEqual([])
  })

  it('surfaces an unnotifiable recipient without stopping the others (FR-140)', async () => {
    const store = createFakeNotificationStore({
      subject: fakeSubject(),
      audience: [
        fakeAudienceMember({ userId: 'ada', slackUserId: null }),
        fakeAudienceMember({ userId: 'grace', relation: 'watcher' }),
      ],
    })
    const slack = createFakeSlackMessenger()

    const result = await notifyWorkflowEvent({
      store,
      messenger: slack,
      workflowId: 'w1',
      event: 'workflow_succeeded',
      panel,
    })

    expect(result.deliveries.map((delivery) => delivery.outcome)).toStrictEqual([
      'unnotifiable',
      'delivered',
    ])
    expect(slack.sent).toHaveLength(1)
  })
})

describe('notifyIntegrationTick (FR-139)', () => {
  it('sends one summary for a fan-out, recorded against no workflow', async () => {
    const store = createFakeNotificationStore({
      subject: fakeSubject(),
      audience: [fakeAudienceMember({ userId: 'ada' })],
    })
    const slack = createFakeSlackMessenger()

    await notifyIntegrationTick({
      store,
      messenger: slack,
      integrationName: 'Acme board',
      panel,
      starts: [
        { workflowId: 'w1', ownerUserId: 'ada' },
        { workflowId: 'w2', ownerUserId: 'ada' },
        { workflowId: 'w3', ownerUserId: 'ada' },
      ],
    })

    expect(slack.sent).toHaveLength(1)
    expect(slack.sent[0]?.text).toContain('started 3 runs')
    expect(store.recorded).toHaveLength(1)
    expect(store.recorded[0]).toMatchObject({
      workflowId: null,
      event: 'integration_tick_summary',
      coalescedCount: 3,
    })
  })

  it('keeps the per-workflow message when the tick started one run for someone', async () => {
    const store = createFakeNotificationStore({
      subject: fakeSubject(),
      audience: [fakeAudienceMember({ userId: 'ada' })],
    })
    const slack = createFakeSlackMessenger()

    await notifyIntegrationTick({
      store,
      messenger: slack,
      integrationName: 'Acme board',
      panel,
      starts: [{ workflowId: 'w1', ownerUserId: 'ada' }],
    })

    expect(store.recorded[0]?.workflowId).toBe('w1')
  })

  it('writes no row for somebody who opted out (FR-138)', async () => {
    const store = createFakeNotificationStore({
      subject: fakeSubject(),
      audience: [fakeAudienceMember({ userId: 'ada', preferenceEnabled: false })],
    })
    const slack = createFakeSlackMessenger()

    await notifyIntegrationTick({
      store,
      messenger: slack,
      integrationName: 'Acme board',
      panel,
      starts: [
        { workflowId: 'w1', ownerUserId: 'ada' },
        { workflowId: 'w2', ownerUserId: 'ada' },
      ],
    })

    // `notifications` records attempts. A message nobody asked for was never attempted.
    expect(store.recorded).toStrictEqual([])
    expect(slack.sent).toStrictEqual([])
  })

  it('does nothing for a tick that started nothing', async () => {
    const store = createFakeNotificationStore()
    const slack = createFakeSlackMessenger()

    await expect(
      notifyIntegrationTick({
        store,
        messenger: slack,
        integrationName: null,
        panel,
        starts: [],
      }),
    ).resolves.toStrictEqual([])
  })
})

const connectionString = readTestDatabaseUrl()

/**
 * **The proof, against a real database.**
 *
 * A workflow in `succeeded` is notified while Slack is entirely down. Afterwards the whole
 * `workflows` row is compared with the copy taken before — every column, `updated_at` included.
 * A delivery path that had grown the ability to mark the run failed, or that merely touched the
 * row, fails here.
 */
describe.skipIf(connectionString === undefined)(
  'a delivery failure leaves the workflow exactly as it was (FR-141)',
  () => {
    let fixture: NotifyFixtures
    let store: NotificationStore
    let ownerUserId: string
    let workflowId: string

    beforeAll(async () => {
      fixture = createNotifyFixtures(connectionString ?? '')
      await fixture.open()
      store = createNotificationStore({ db: fixture.db() })

      ownerUserId = await fixture.seedUser({ label: 'owner' })
      workflowId = await fixture.seedWorkflow({ ownerUserId, state: 'succeeded' })
    }, 60_000)

    afterAll(async () => {
      await fixture.close()
    }, 30_000)

    it('changes not one column of the run when Slack is down', async () => {
      const before = await fixture.readWorkflow(workflowId)
      expect(before).toBeDefined()

      const slack = createFakeSlackMessenger({ failure: new Error('slack is unreachable') })

      const result = await notifyWorkflowEvent({
        store,
        messenger: slack,
        workflowId,
        event: 'workflow_succeeded',
        panel,
      })

      expect(result.deliveries.map((delivery) => delivery.outcome)).toStrictEqual(['failed'])

      const after = await fixture.readWorkflow(workflowId)

      // Field for field, not `state` alone: an implementation that flipped `terminal_outcome`, or
      // wrote a reason, or merely bumped `updated_at`, is one that reached the row at all.
      expect(after).toStrictEqual(before)
      expect(after?.state).toBe<Workflow['state']>('succeeded')
      expect(after?.terminalOutcome).toBe('succeeded')
    })

    it('still recorded the failed attempt, so the failure is visible (FR-141)', async () => {
      const recorded = await fixture.readNotifications()

      expect(recorded).toHaveLength(1)
      expect(recorded[0]).toMatchObject({
        workflowId,
        recipientUserId: ownerUserId,
        event: 'workflow_succeeded',
        channel: 'slack_dm',
        outcome: 'failed',
      })
      expect(recorded[0]?.error).toContain('slack is unreachable')
    })

    it('delivers normally once Slack recovers, without the run having moved', async () => {
      const before = await fixture.readWorkflow(workflowId)
      const slack = createFakeSlackMessenger()

      const result = await notifyWorkflowEvent({
        store,
        messenger: slack,
        workflowId,
        event: 'workflow_succeeded',
        panel,
      })

      expect(result.deliveries.map((delivery) => delivery.outcome)).toStrictEqual(['delivered'])
      expect(slack.sent[0]?.text).toContain(fixture.workspaceName)
      await expect(fixture.readWorkflow(workflowId)).resolves.toStrictEqual(before)
    })
  },
)
