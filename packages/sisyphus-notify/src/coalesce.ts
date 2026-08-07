import type { NotificationEvent } from '@bluetel-ai/sisyphus-api/client'

import type { RecentDelivery } from './notification-store'
import type { NotificationRecipient } from './recipients'

/**
 * Coalescing and rate limiting (T085, FR-139) — **and the arithmetic that keeps it inside SC-034.**
 *
 * FR-139 asks for two different things, and they need two different mechanisms:
 *
 * - *one workflow cannot produce a burst of messages* — a run that goes
 *   `needs_attention` → corrected → `running` → `succeeded` inside a minute is one notification,
 *   not four. This is a **time window** per (workflow, recipient), below.
 * - *an integration tick that starts many workflows produces one summary* — a fan-out, not a
 *   sequence. No window helps: the twenty messages are simultaneous and each concerns a different
 *   run. This is a **grouping**, in {@link planIntegrationTickSummaries}, and it is why
 *   `notifications.workflow_id` is nullable.
 *
 * ## Why the window is 45 seconds
 *
 * SC-034 gives 2 minutes from a state being reached to its owner learning about it, for 99% of
 * events. Everything in that budget is spent in three places, and the window is what is left after
 * the other two:
 *
 * | Stage                                   | Worst case | Why                                        |
 * | --------------------------------------- | ---------- | ------------------------------------------ |
 * | waiting for the next notify tick        | 30 s       | a transition landing just after one ran    |
 * | held open by the coalescing window      | 45 s       | {@link COALESCE_WINDOW_MS}                 |
 * | Slack round trip, plus one retry        | ~5 s       | two API calls                              |
 * | **total**                               | **~80 s**  | against a 120 s budget                     |
 *
 * That leaves roughly 40 seconds of headroom, which is the point of choosing 45 rather than the
 * more natural-looking minute: a 60-second window plus a 30-second tick is 90 seconds before Slack
 * has been called at all, and one slow round trip then breaks the requirement the coalescing was
 * meant to serve. `coalesce.test.ts` asserts the sum against
 * {@link NOTIFICATION_DELIVERY_BUDGET_MS} rather than leaving it as prose, so raising either
 * constant past the budget fails the build.
 *
 * ## Why deferral is bounded by one window and cannot starve
 *
 * A held message becomes ready at `lastDelivered + COALESCE_WINDOW_MS` — measured from the last
 * **delivery**, never from the last event. Measuring from the last event would let a run that keeps
 * changing hold its notification open indefinitely, which is precisely the failure SC-034 forbids
 * and the one an "as things settle down" implementation produces. Measured from the delivery, the
 * wait is at most one window however busy the run is.
 *
 * There is deliberately **no global per-recipient cap** on top of this. A cap that deferred a
 * person's eleventh message into the next window would push past the two-minute budget for that
 * message, which is to say it would break SC-034 in the name of enforcing FR-139 — and FR-139's
 * actual fan-out case is the integration tick, which is handled by grouping rather than by waiting.
 */

/** How often the notify job runs. One tick of latency is the cost of not being event-driven. */
export const NOTIFY_TICK_MS = 30_000

/** The per-(workflow, recipient) coalescing window. See the module comment for the arithmetic. */
export const COALESCE_WINDOW_MS = 45_000

/** SC-034's two minutes, in milliseconds. The number the two above are chosen against. */
export const NOTIFICATION_DELIVERY_BUDGET_MS = 120_000

/** Slack's two calls plus one retry, generously. Not a timeout — a term in the budget. */
export const SLACK_ROUND_TRIP_ALLOWANCE_MS = 5_000

/** How many runs one tick must start for a recipient before the summary replaces the messages. */
export const TICK_SUMMARY_THRESHOLD = 2

/**
 * Worst-case time from a state being reached to the message being sent.
 *
 * Exported so the budget is a computed value a test can assert on, rather than a claim in a
 * comment that stops being true when somebody edits a constant.
 */
export const worstCaseDeliveryLatencyMs = (): number =>
  NOTIFY_TICK_MS + COALESCE_WINDOW_MS + SLACK_ROUND_TRIP_ALLOWANCE_MS

/** One state change waiting to be told to somebody. */
export interface PendingTransition {
  readonly event: NotificationEvent
  readonly occurredAt: Date
}

/** A message to send now, standing for one or more transitions. */
export interface CoalescedDelivery {
  readonly recipientUserId: string
  /** The **latest** pending event. A message headed by a superseded state would misinform. */
  readonly event: NotificationEvent
  /** How many transitions it stands for. `1` when nothing was folded. */
  readonly coalescedCount: number
}

/** A message held open, and when it will be ready. */
export interface DeferredDelivery {
  readonly recipientUserId: string
  readonly heldCount: number
  readonly readyAt: Date
}

/** What {@link planWorkflowDeliveries} decides, per recipient. */
export interface WorkflowNotificationPlan {
  readonly send: readonly CoalescedDelivery[]
  readonly defer: readonly DeferredDelivery[]
}

/** The most recent of a set of transitions. */
const latestOf = (transitions: readonly PendingTransition[]): PendingTransition | undefined =>
  transitions.reduce<PendingTransition | undefined>(
    (latest, transition) =>
      latest === undefined || transition.occurredAt.getTime() > latest.occurredAt.getTime()
        ? transition
        : latest,
    undefined,
  )

/** The newest delivery to one person, or `undefined` when there is none in the window. */
const lastDeliveryTo = (
  deliveries: readonly RecentDelivery[],
  recipientUserId: string,
): Date | undefined =>
  deliveries
    .filter((delivery) => delivery.recipientUserId === recipientUserId)
    .reduce<
      Date | undefined
    >((latest, delivery) => (latest === undefined || delivery.deliveredAt.getTime() > latest.getTime() ? delivery.deliveredAt : latest), undefined)

/**
 * Decide, per recipient, whether one workflow's pending transitions go out now or are held (FR-139).
 *
 * Pure: it takes the recent delivery history rather than reading it, so the window can be exercised
 * at any point on either side of its boundary without waiting for real time to pass.
 *
 * @param input.recipients - Already filtered by preference; see `./recipients.ts`.
 * @param input.pending - Every transition for this workflow not yet told to anyone.
 * @param input.recentDeliveries - Delivered notifications for this workflow within the window.
 * @param input.now - The clock, injected.
 */
export const planWorkflowDeliveries = (input: {
  readonly recipients: readonly NotificationRecipient[]
  readonly pending: readonly PendingTransition[]
  readonly recentDeliveries: readonly RecentDelivery[]
  readonly now: Date
}): WorkflowNotificationPlan => {
  const { recipients, pending, recentDeliveries, now } = input

  const latest = latestOf(pending)
  if (latest === undefined) {
    return { send: [], defer: [] }
  }

  const send: CoalescedDelivery[] = []
  const defer: DeferredDelivery[] = []

  for (const recipient of recipients) {
    const lastDelivered = lastDeliveryTo(recentDeliveries, recipient.userId)

    // Measured from the last delivery, never from the last event: see the module comment on why
    // the other reading starves.
    if (
      lastDelivered !== undefined &&
      now.getTime() - lastDelivered.getTime() < COALESCE_WINDOW_MS
    ) {
      defer.push({
        recipientUserId: recipient.userId,
        heldCount: pending.length,
        readyAt: new Date(lastDelivered.getTime() + COALESCE_WINDOW_MS),
      })
      continue
    }

    send.push({
      recipientUserId: recipient.userId,
      event: latest.event,
      coalescedCount: pending.length,
    })
  }

  return { send, defer }
}

/** One run an integration tick started, and who owns it. */
export interface TickStart {
  readonly workflowId: string
  readonly ownerUserId: string
}

/** One summary message covering several runs (FR-139). */
export interface TickSummaryPlan {
  readonly kind: 'summary'
  readonly recipientUserId: string
  readonly workflowIds: readonly string[]
}

/** A tick that started one run for this person, which is not a fan-out. */
export interface TickIndividualPlan {
  readonly kind: 'individual'
  readonly recipientUserId: string
  readonly workflowId: string
}

export type TickPlanEntry = TickIndividualPlan | TickSummaryPlan

/**
 * Group one tick's starts so a recipient gets **one** message however many runs it began (FR-139).
 *
 * The grouping is per recipient rather than per tick, because the channel is a direct message and
 * there is no such thing as a message to everybody. A recipient the tick started a single run for
 * gets the ordinary per-workflow message: a "summary" of one run is a worse message than the
 * message it replaced, and it would lose the `workflow_id` on the row for no benefit.
 *
 * Order is the order the runs were started in, so the summary reads the way the tick happened.
 *
 * @param input.starts - Every run this tick began.
 * @param input.threshold - How many runs make a fan-out. Defaults to {@link TICK_SUMMARY_THRESHOLD}.
 */
export const planIntegrationTickSummaries = (input: {
  readonly starts: readonly TickStart[]
  readonly threshold?: number
}): readonly TickPlanEntry[] => {
  const threshold = input.threshold ?? TICK_SUMMARY_THRESHOLD

  const byOwner = new Map<string, string[]>()
  for (const start of input.starts) {
    const existing = byOwner.get(start.ownerUserId)
    if (existing === undefined) {
      byOwner.set(start.ownerUserId, [start.workflowId])
    } else {
      existing.push(start.workflowId)
    }
  }

  const plan: TickPlanEntry[] = []
  for (const [recipientUserId, workflowIds] of byOwner) {
    if (workflowIds.length >= threshold) {
      plan.push({ kind: 'summary', recipientUserId, workflowIds })
      continue
    }

    for (const workflowId of workflowIds) {
      plan.push({ kind: 'individual', recipientUserId, workflowId })
    }
  }

  return plan
}
