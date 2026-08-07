import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  COALESCE_WINDOW_MS,
  NOTIFICATION_DELIVERY_BUDGET_MS,
  NOTIFY_TICK_MS,
  planIntegrationTickSummaries,
  planWorkflowDeliveries,
  SLACK_ROUND_TRIP_ALLOWANCE_MS,
  TICK_SUMMARY_THRESHOLD,
  worstCaseDeliveryLatencyMs,
} from './coalesce'
import { notifyWorkflowEvent } from './delivery'
import {
  createFakeNotificationStore,
  fakeAudienceMember,
  fakeSubject,
} from './notification-store-fake'
import type { NotificationRecipient } from './recipients'
import { createFakeSlackMessenger } from './slack-fake'

/**
 * Coalescing (FR-139) **and its budget** (SC-034).
 *
 * The budget is asserted twice, deliberately, because the two assertions answer different questions
 * and FR-205 is explicit that only one of them is evidence.
 *
 * The **declared budget** — `NOTIFY_TICK_MS + COALESCE_WINDOW_MS + SLACK_ROUND_TRIP_ALLOWANCE_MS`
 * against `NOTIFICATION_DELIVERY_BUDGET_MS` — is a statement of intent. It is worth keeping: the
 * window is a number chosen against a requirement stated in a different document, and prose saying
 * "45 s fits inside 2 minutes" stops being true the moment somebody raises a constant. Here it
 * fails the build instead.
 *
 * But it is arithmetic. `a + b + c < d` keeps passing when the coalescing is slow, when it is
 * quadratic in the number of recipients, and when nothing calls it at all — which is precisely the
 * class of "test" FR-205 was written about. So the last block below **performs the operation** and
 * measures the clock across it, on the fake clock so the suite does not have to wait out a
 * 45-second window to find out that the window is honoured.
 */

const recipient = (userId: string): NotificationRecipient => ({
  userId,
  displayName: `User ${userId}`,
  slackUserId: `U${userId}`,
  relation: 'owner',
  notifiable: true,
})

const NOW = new Date('2026-01-01T12:00:00.000Z')
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs)

describe('the declared budget fits inside SC-034 (2 minutes) — stated intent, not evidence', () => {
  it('leaves headroom after a tick, a window and a Slack round trip', () => {
    expect(worstCaseDeliveryLatencyMs()).toBe(
      NOTIFY_TICK_MS + COALESCE_WINDOW_MS + SLACK_ROUND_TRIP_ALLOWANCE_MS,
    )
    expect(worstCaseDeliveryLatencyMs()).toBeLessThan(NOTIFICATION_DELIVERY_BUDGET_MS)
  })

  it('keeps at least a quarter of the budget spare, so one slow call cannot break it', () => {
    // 45 s rather than the more natural-looking 60: a minute-long window plus a 30 s tick is 90 s
    // before Slack has been called at all, and one slow round trip then breaks the requirement the
    // coalescing exists to serve.
    const headroom = NOTIFICATION_DELIVERY_BUDGET_MS - worstCaseDeliveryLatencyMs()
    expect(headroom).toBeGreaterThanOrEqual(NOTIFICATION_DELIVERY_BUDGET_MS / 4)
  })
})

describe('planWorkflowDeliveries — one workflow cannot produce a burst (FR-139)', () => {
  it('folds several rapid transitions into one message headed by the latest', () => {
    const plan = planWorkflowDeliveries({
      recipients: [recipient('owner')],
      pending: [
        { event: 'workflow_needs_attention', occurredAt: at(-8_000) },
        { event: 'workflow_capped', occurredAt: at(-4_000) },
        { event: 'workflow_succeeded', occurredAt: at(-1_000) },
      ],
      recentDeliveries: [],
      now: NOW,
    })

    expect(plan.send).toStrictEqual([
      // The latest event, not the first: a message headed by a state the run has already left
      // would misinform the person it is meant to help.
      { recipientUserId: 'owner', event: 'workflow_succeeded', coalescedCount: 3 },
    ])
    expect(plan.defer).toStrictEqual([])
  })

  it('sends immediately when nothing has reached this person recently', () => {
    const plan = planWorkflowDeliveries({
      recipients: [recipient('owner')],
      pending: [{ event: 'workflow_failed', occurredAt: NOW }],
      recentDeliveries: [{ recipientUserId: 'owner', deliveredAt: at(-COALESCE_WINDOW_MS - 1) }],
      now: NOW,
    })

    expect(plan.send).toHaveLength(1)
    expect(plan.send[0]?.coalescedCount).toBe(1)
  })

  it('holds a message when one went out inside the window, and says when it comes due', () => {
    const lastDelivered = at(-10_000)

    const plan = planWorkflowDeliveries({
      recipients: [recipient('owner')],
      pending: [
        { event: 'workflow_needs_attention', occurredAt: at(-2_000) },
        { event: 'workflow_succeeded', occurredAt: NOW },
      ],
      recentDeliveries: [{ recipientUserId: 'owner', deliveredAt: lastDelivered }],
      now: NOW,
    })

    expect(plan.send).toStrictEqual([])
    expect(plan.defer).toStrictEqual([
      {
        recipientUserId: 'owner',
        heldCount: 2,
        readyAt: new Date(lastDelivered.getTime() + COALESCE_WINDOW_MS),
      },
    ])
  })

  it('measures the wait from the last delivery, so a busy run cannot starve its owner', () => {
    // The alternative reading — wait until the run settles down — defers indefinitely while
    // transitions keep arriving, which is exactly what SC-034 forbids. Here the deadline is fixed
    // by the delivery, so however many events land, the hold is at most one window.
    const lastDelivered = at(-10_000)

    const plan = planWorkflowDeliveries({
      recipients: [recipient('owner')],
      pending: Array.from({ length: 20 }, (_unused, index) => ({
        event: 'workflow_needs_attention' as const,
        occurredAt: at(index * 100),
      })),
      recentDeliveries: [{ recipientUserId: 'owner', deliveredAt: lastDelivered }],
      now: NOW,
    })

    const readyAt = plan.defer[0]?.readyAt.getTime() ?? 0
    expect(readyAt - NOW.getTime()).toBeLessThanOrEqual(COALESCE_WINDOW_MS)
  })

  it('is exclusive at the boundary, so the window cannot hold a message forever', () => {
    const plan = planWorkflowDeliveries({
      recipients: [recipient('owner')],
      pending: [{ event: 'workflow_succeeded', occurredAt: NOW }],
      recentDeliveries: [{ recipientUserId: 'owner', deliveredAt: at(-COALESCE_WINDOW_MS) }],
      now: NOW,
    })

    expect(plan.send).toHaveLength(1)
  })

  it('decides per recipient rather than for the run as a whole', () => {
    const plan = planWorkflowDeliveries({
      recipients: [recipient('owner'), recipient('watcher')],
      pending: [{ event: 'workflow_succeeded', occurredAt: NOW }],
      recentDeliveries: [{ recipientUserId: 'owner', deliveredAt: at(-1_000) }],
      now: NOW,
    })

    expect(plan.send.map((entry) => entry.recipientUserId)).toStrictEqual(['watcher'])
    expect(plan.defer.map((entry) => entry.recipientUserId)).toStrictEqual(['owner'])
  })

  it('plans nothing when there is nothing pending', () => {
    expect(
      planWorkflowDeliveries({
        recipients: [recipient('owner')],
        pending: [],
        recentDeliveries: [],
        now: NOW,
      }),
    ).toStrictEqual({ send: [], defer: [] })
  })
})

describe('planIntegrationTickSummaries — one tick, one message (FR-139)', () => {
  it('replaces a fan-out with a single summary per owner', () => {
    const plan = planIntegrationTickSummaries({
      starts: [
        { workflowId: 'w1', ownerUserId: 'ada' },
        { workflowId: 'w2', ownerUserId: 'ada' },
        { workflowId: 'w3', ownerUserId: 'ada' },
      ],
    })

    expect(plan).toStrictEqual([
      { kind: 'summary', recipientUserId: 'ada', workflowIds: ['w1', 'w2', 'w3'] },
    ])
  })

  it('groups per person, because the channel is a direct message', () => {
    const plan = planIntegrationTickSummaries({
      starts: [
        { workflowId: 'w1', ownerUserId: 'ada' },
        { workflowId: 'w2', ownerUserId: 'grace' },
        { workflowId: 'w3', ownerUserId: 'ada' },
        { workflowId: 'w4', ownerUserId: 'grace' },
      ],
    })

    expect(plan).toStrictEqual([
      { kind: 'summary', recipientUserId: 'ada', workflowIds: ['w1', 'w3'] },
      { kind: 'summary', recipientUserId: 'grace', workflowIds: ['w2', 'w4'] },
    ])
  })

  it('keeps the ordinary per-workflow message when the tick started one run for someone', () => {
    // A "summary" of one run is a worse message than the one it replaces, and it would lose the
    // `workflow_id` on the recorded row for no benefit.
    const plan = planIntegrationTickSummaries({
      starts: [
        { workflowId: 'w1', ownerUserId: 'ada' },
        { workflowId: 'w2', ownerUserId: 'grace' },
        { workflowId: 'w3', ownerUserId: 'grace' },
      ],
    })

    expect(plan).toStrictEqual([
      { kind: 'individual', recipientUserId: 'ada', workflowId: 'w1' },
      { kind: 'summary', recipientUserId: 'grace', workflowIds: ['w2', 'w3'] },
    ])
  })

  it('takes a threshold, defaulting to two', () => {
    expect(TICK_SUMMARY_THRESHOLD).toBe(2)

    const plan = planIntegrationTickSummaries({
      starts: [
        { workflowId: 'w1', ownerUserId: 'ada' },
        { workflowId: 'w2', ownerUserId: 'ada' },
      ],
      threshold: 3,
    })

    expect(plan.every((entry) => entry.kind === 'individual')).toBe(true)
  })

  it('plans nothing for a tick that started nothing', () => {
    expect(planIntegrationTickSummaries({ starts: [] })).toStrictEqual([])
  })
})

/**
 * SC-034, **measured** (T189, FR-205).
 *
 * The block at the top of this file adds three constants together. This one runs the operation the
 * criterion is about — a transition, the wait for the next notify tick, the coalescing hold, and a
 * Slack round trip — and reads the clock across it. The elapsed time comes from the code's own
 * decisions: how long the message is held is `planWorkflowDeliveries`' answer, not a number
 * restated here, so an implementation that held it for two windows fails this and passes the sum.
 *
 * The clock is fake because the honest worst case is 80 seconds of waiting and a suite that
 * actually waited would be deleted within a month. Fake timers move `Date.now()` and fire the
 * pending `setTimeout`s in order, so what is elided is the waiting, not the sequencing — the
 * measurement is still of the operation rather than of an assumption about it.
 */
describe('SC-034 measured across the operation (FR-205)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** A messenger whose two calls cost real (fake-clock) time, as Slack's do. */
  const slowMessenger = (roundTripMs: number) => {
    const inner = createFakeSlackMessenger()
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

    return {
      inner,
      messenger: {
        openDirectMessage: async (input: { readonly slackUserId: string }) => {
          await sleep(roundTripMs / 2)
          return inner.openDirectMessage(input)
        },
        postMessage: async (input: { readonly channelId: string; readonly text: string }) => {
          await sleep(roundTripMs / 2)
          return inner.postMessage(input)
        },
      },
    }
  }

  const storeFor = (recentDeliveries: readonly { recipientUserId: string; deliveredAt: Date }[]) =>
    createFakeNotificationStore({
      subject: fakeSubject({ ownerUserId: 'ada' }),
      audience: [fakeAudienceMember({ userId: 'ada' })],
      recentDeliveries,
    })

  it('gets the worst case — a missed tick, a full hold and a slow round trip — inside 2 minutes', async () => {
    const transitionAt = new Date()
    // The worst case on both counts: the transition lands the instant after a notify tick ran, and
    // this recipient was messaged at that same instant, so the window holds the next one in full.
    const store = storeFor([{ recipientUserId: 'ada', deliveredAt: transitionAt }])
    const { inner, messenger } = slowMessenger(SLACK_ROUND_TRIP_ALLOWANCE_MS)

    const notify = () =>
      notifyWorkflowEvent({
        store,
        messenger,
        panel: { baseUrl: 'https://panel.example' },
        workflowId: '00000000-0000-7000-8000-000000000001',
        event: 'workflow_succeeded',
        pending: [{ event: 'workflow_succeeded', occurredAt: transitionAt }],
        now: new Date(),
      })

    // 1. Wait for the next notify tick to come round.
    await vi.advanceTimersByTimeAsync(NOTIFY_TICK_MS)

    // 2. It runs, and the coalescing window holds the message. The tick makes no Slack call.
    const held = await notify()
    expect(held.deliveries).toStrictEqual([])
    expect(inner.opened).toStrictEqual([])

    // 3. Wait until the plan itself says the message is due — the code's number, not ours.
    expect(held.deferred).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(held.deferred[0].readyAt.getTime() - Date.now())

    // 4. The next tick sends it, and the round trip costs what a round trip costs.
    const sending = notify()
    await vi.advanceTimersByTimeAsync(SLACK_ROUND_TRIP_ALLOWANCE_MS)
    const sent = await sending

    const elapsedMs = Date.now() - transitionAt.getTime()

    expect(sent.deliveries.map((delivery) => delivery.outcome)).toStrictEqual(['delivered'])
    expect(inner.sent).toHaveLength(1)
    expect(elapsedMs).toBeLessThan(NOTIFICATION_DELIVERY_BUDGET_MS)

    // And it really did take the time it claims to. A measurement that came out at zero would mean
    // the operation never ran, which is the other way FR-205's arithmetic passes vacuously.
    expect(elapsedMs).toBeGreaterThanOrEqual(COALESCE_WINDOW_MS + SLACK_ROUND_TRIP_ALLOWANCE_MS)

    // Note what measuring shows that summing cannot: the declared budget adds the tick wait to the
    // window, and the two in fact **overlap** — the window is measured from the last delivery, which
    // is running down while the tick is being waited for. So the real worst case is 50 s against a
    // declared 80 s. The constants stay conservative on purpose; this is the number to trust.
    expect(elapsedMs).toBeLessThanOrEqual(worstCaseDeliveryLatencyMs())
  })

  it('holds a run that keeps changing for one window, not for as long as it keeps changing', async () => {
    // The starvation case, measured rather than reasoned about: twenty transitions arrive while the
    // message is held, and the delivery still lands inside the budget measured from the *first*.
    const transitionAt = new Date()
    const store = storeFor([{ recipientUserId: 'ada', deliveredAt: transitionAt }])
    const { inner, messenger } = slowMessenger(SLACK_ROUND_TRIP_ALLOWANCE_MS)

    const pending = Array.from({ length: 20 }, (_unused, index) => ({
      event: 'workflow_needs_attention' as const,
      occurredAt: new Date(transitionAt.getTime() + index * 1_000),
    }))

    const notify = () =>
      notifyWorkflowEvent({
        store,
        messenger,
        panel: { baseUrl: 'https://panel.example' },
        workflowId: '00000000-0000-7000-8000-000000000001',
        event: 'workflow_needs_attention',
        pending,
        now: new Date(),
      })

    await vi.advanceTimersByTimeAsync(NOTIFY_TICK_MS)
    const held = await notify()
    expect(held.deferred).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(held.deferred[0].readyAt.getTime() - Date.now())
    const sending = notify()
    await vi.advanceTimersByTimeAsync(SLACK_ROUND_TRIP_ALLOWANCE_MS)
    await sending

    expect(Date.now() - transitionAt.getTime()).toBeLessThan(NOTIFICATION_DELIVERY_BUDGET_MS)
    // One message for the twenty, which is the other half of FR-139.
    expect(inner.sent).toHaveLength(1)
    expect(inner.sent[0]?.text).toContain('This covers 20 changes')
  })
})

/**
 * The planning itself, timed on the real clock (FR-205).
 *
 * Fake timers prove the *waiting* is bounded; they cannot catch a planner that is quadratic in the
 * number of recipients, because a fake clock does not advance while real code runs. This one does
 * the work and reads `performance.now()` across it. The bound is deliberately a small fraction of
 * the budget rather than a tight number — the assertion is "this is not where the two minutes go",
 * and a tight bound on a shared CI box is a flake rather than a test.
 */
describe('planning a large fan-out is not where the budget goes (FR-205)', () => {
  it('plans two hundred recipients against two hundred transitions in well under a second', () => {
    const recipients = Array.from({ length: 200 }, (_unused, index) => recipient(`user-${index}`))
    const pending = Array.from({ length: 200 }, (_unused, index) => ({
      event: 'workflow_needs_attention' as const,
      occurredAt: at(index * 10),
    }))
    const recentDeliveries = recipients.map((person) => ({
      recipientUserId: person.userId,
      deliveredAt: at(-1_000),
    }))

    const startedAt = performance.now()
    const plan = planWorkflowDeliveries({ recipients, pending, recentDeliveries, now: NOW })
    const elapsedMs = performance.now() - startedAt

    expect(plan.defer).toHaveLength(200)
    expect(elapsedMs).toBeLessThan(NOTIFICATION_DELIVERY_BUDGET_MS / 200)
  })
})
