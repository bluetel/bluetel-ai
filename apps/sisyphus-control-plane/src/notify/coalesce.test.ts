import { describe, expect, it } from 'vitest'

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
import type { NotificationRecipient } from './recipients'

/**
 * Coalescing (FR-139) **and its budget** (SC-034).
 *
 * The budget assertion is the one that earns its place: the window is a number chosen against a
 * requirement stated in a different document, and prose saying "45 s fits inside 2 minutes" stops
 * being true the moment somebody raises a constant. Here it fails the build instead.
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

describe('the window fits inside SC-034 (2 minutes)', () => {
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
