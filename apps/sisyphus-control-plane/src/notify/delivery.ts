import type { NotificationEvent } from '@bluetel-ai/sisyphus-api/client'
import type { Notification } from '@bluetel-ai/sisyphus-api/db'

import type { PendingTransition, TickStart } from './coalesce'
import {
  COALESCE_WINDOW_MS,
  planIntegrationTickSummaries,
  planWorkflowDeliveries,
} from './coalesce'
import { composeTickSummaryMessage, composeWorkflowMessage } from './message'
import type { PanelLink } from './message'
import type { NotificationStore } from './notification-store'
import type { NotificationRecipient } from './recipients'
import { selectRecipients } from './recipients'
import type { SlackDirectMessenger } from './slack'

/**
 * Delivering a notification — **outside the state transition, always** (T084, FR-140, FR-141).
 *
 * ## How "a delivery failure cannot alter workflow state" is made structural
 *
 * Look at what this module is given: a {@link NotificationStore} and a
 * {@link SlackDirectMessenger}. That is the complete list. There is no `SisyphusDatabase`, no
 * transaction, no `workflows` import and no path to one — the store's five methods are four reads
 * and one append into `notifications`, and the messenger's two are Slack calls. **A function here
 * cannot fail a run, because it has nothing to fail it with.**
 *
 * That is deliberately different from the usual formulation, which is a comment asking the caller
 * to be careful about ordering. Ordering is a property of the call site and survives exactly as
 * long as nobody edits the call site; a missing parameter is a property of the type and survives
 * a refactor by somebody who has not read this paragraph. FR-141's requirement — a run that
 * succeeded and could not be announced is a **successful run with a failed notification** — is
 * therefore not something this module promises to honour. It is something it is unable to violate.
 *
 * The caller's remaining obligation is only that it calls this *after* its transaction has
 * committed, so a slow Slack call cannot hold a row lock. That is a performance property, not a
 * correctness one, and it is the reason `notifyWorkflowEvent` takes a workflow **id** rather than a
 * transaction or a row.
 *
 * ## Nothing here throws
 *
 * Every path returns a {@link NotificationDelivery}. A Slack outage, a closed DM, a user with no
 * Slack identity: each is recorded and returned, none propagates. A caller that had to wrap this in
 * a `try` would eventually be a caller that did not, and the thrown error would land in whatever
 * job was doing something more important — which is the same failure FR-141 forbids, arriving by
 * the back door.
 *
 * ## Unnotifiable is surfaced, not swallowed
 *
 * A user with no resolvable Slack identity produces an `unnotifiable` row against the workflow with
 * the recipient and the reason, which is what the panel reads to surface them (FR-140). It is not a
 * failure and not a silent skip: the run continues, and the record exists so somebody can fix the
 * identity.
 */

/** What happened for one recipient. */
export interface NotificationDelivery {
  readonly recipientUserId: string
  readonly outcome: Notification['outcome']
  /** The recorded row, so a caller can report without a second read. */
  readonly notification: Notification
}

/** The two collaborators, and nothing else. This shape is the FR-141 guarantee. */
export interface DeliveryDependencies {
  readonly store: NotificationStore
  readonly messenger: SlackDirectMessenger
}

/** One message, to one person, about one thing. */
export interface DeliveryRequest {
  /** `null` for the integration-tick summary, which is about many runs (FR-139). */
  readonly workflowId: string | null
  readonly event: NotificationEvent
  readonly recipient: NotificationRecipient
  readonly text: string
  readonly coalescedCount?: number
}

/** Turn an unknown thrown value into a message without losing its content. */
const describe = (thrown: unknown): string =>
  thrown instanceof Error ? thrown.message : String(thrown)

/**
 * Send one direct message and record the attempt (FR-140, FR-141).
 *
 * Never throws. Never touches the workflow — see the module comment for why it could not.
 *
 * @param dependencies - See {@link DeliveryDependencies}.
 * @param request - See {@link DeliveryRequest}.
 */
export const deliverNotification = async (
  dependencies: DeliveryDependencies,
  request: DeliveryRequest,
): Promise<NotificationDelivery> => {
  const { store, messenger } = dependencies
  const { workflowId, event, recipient, text } = request
  const coalescedCount = request.coalescedCount ?? 1

  const record = async (
    outcome: Notification['outcome'],
    error: string | null,
  ): Promise<NotificationDelivery> => ({
    recipientUserId: recipient.userId,
    outcome,
    notification: await store.recordAttempt({
      workflowId,
      recipientUserId: recipient.userId,
      event,
      outcome,
      coalescedCount,
      error,
    }),
  })

  // FR-140's first case, and the cheap one: we already know there is nowhere to send this.
  if (!recipient.notifiable || recipient.slackUserId === null) {
    return record('unnotifiable', 'The user has no resolvable Slack identity.')
  }

  let channelId: string | undefined
  try {
    channelId = await messenger.openDirectMessage({ slackUserId: recipient.slackUserId })
  } catch (thrown) {
    // A platform problem — an expired token, a rate limit, a network fault. Retryable, and
    // therefore `failed` rather than `unnotifiable`: marking it unnotifiable would file an outage
    // as a fact about the person.
    return record('failed', describe(thrown))
  }

  // FR-140's second case: Slack answered, and the answer is that this person cannot be reached.
  if (channelId === undefined) {
    return record('unnotifiable', 'Slack would not open a direct message with this user.')
  }

  try {
    await messenger.postMessage({ channelId, text })
  } catch (thrown) {
    return record('failed', describe(thrown))
  }

  return record('delivered', null)
}

/** What a workflow-event notification did, per recipient, plus what it held back. */
export interface WorkflowNotificationResult {
  readonly deliveries: readonly NotificationDelivery[]
  /** Recipients whose message is held by the coalescing window, and when it comes due (FR-139). */
  readonly deferred: readonly { readonly recipientUserId: string; readonly readyAt: Date }[]
}

/** Everything {@link notifyWorkflowEvent} needs. Note the absence of a database handle. */
export interface NotifyWorkflowEventOptions extends DeliveryDependencies {
  readonly workflowId: string
  readonly event: NotificationEvent
  readonly panel: PanelLink
  /**
   * Transitions this message stands for. Defaults to the single `event` at `now`, which is the
   * ordinary case; the caller passes more only when it is draining a backlog.
   */
  readonly pending?: readonly PendingTransition[]
  readonly now?: Date
}

/**
 * Notify a run's owner and watchers that it reached a state (FR-136, FR-138, FR-139, FR-141).
 *
 * Called **after** the transition has committed. Reads who should hear about it, applies the
 * coalescing window, sends what is due and records every attempt. Returns rather than throws, for
 * every failure mode.
 *
 * A workflow that has vanished produces an empty result rather than an error: the run being gone is
 * not a delivery failure, and there is nobody left to tell.
 *
 * @param options - See {@link NotifyWorkflowEventOptions}.
 */
export const notifyWorkflowEvent = async (
  options: NotifyWorkflowEventOptions,
): Promise<WorkflowNotificationResult> => {
  const { store, messenger, workflowId, event, panel } = options
  const now = options.now ?? new Date()
  const pending = options.pending ?? [{ event, occurredAt: now }]

  const subject = await store.readSubject(workflowId)
  if (subject === undefined) {
    return { deliveries: [], deferred: [] }
  }

  const recipients = selectRecipients(await store.readAudience({ workflowId, event }))
  const recentDeliveries = await store.readRecentDeliveries({
    workflowId,
    since: new Date(now.getTime() - COALESCE_WINDOW_MS),
  })

  const plan = planWorkflowDeliveries({ recipients, pending, recentDeliveries, now })
  const byUserId = new Map(recipients.map((recipient) => [recipient.userId, recipient]))

  const deliveries: NotificationDelivery[] = []
  for (const entry of plan.send) {
    const recipient = byUserId.get(entry.recipientUserId)
    if (recipient === undefined) {
      continue
    }

    deliveries.push(
      await deliverNotification(
        { store, messenger },
        {
          workflowId,
          event: entry.event,
          recipient,
          coalescedCount: entry.coalescedCount,
          text: composeWorkflowMessage({
            subject,
            event: entry.event,
            panel,
            coalescedCount: entry.coalescedCount,
          }),
        },
      ),
    )
  }

  return {
    deliveries,
    deferred: plan.defer.map((held) => ({
      recipientUserId: held.recipientUserId,
      readyAt: held.readyAt,
    })),
  }
}

/** Everything {@link notifyIntegrationTick} needs. Again, no database handle. */
export interface NotifyIntegrationTickOptions extends DeliveryDependencies {
  readonly integrationName: string | null
  readonly starts: readonly TickStart[]
  readonly panel: PanelLink
}

/**
 * Tell owners about the runs one integration tick started — **one message each** (FR-139).
 *
 * A recipient the tick started several runs for gets a single `integration_tick_summary` whose
 * `notifications.workflow_id` is null, because the message is about none of the runs in
 * particular. A recipient with one run gets the ordinary per-workflow message, which keeps its
 * `workflow_id` and therefore stays on that run's audit.
 *
 * @param options - See {@link NotifyIntegrationTickOptions}.
 */
export const notifyIntegrationTick = async (
  options: NotifyIntegrationTickOptions,
): Promise<readonly NotificationDelivery[]> => {
  const { store, messenger, integrationName, starts, panel } = options

  const plan = planIntegrationTickSummaries({ starts })
  if (plan.length === 0) {
    return []
  }

  const summaryEvent: NotificationEvent = 'integration_tick_summary'
  const recipientIds = [...new Set(plan.map((entry) => entry.recipientUserId))]
  const audience = await store.readAudienceByUser({ userIds: recipientIds, event: summaryEvent })
  const byUserId = new Map(selectRecipients(audience).map((person) => [person.userId, person]))

  const deliveries: NotificationDelivery[] = []
  for (const entry of plan) {
    const recipient = byUserId.get(entry.recipientUserId)
    if (recipient === undefined) {
      // Opted out or deactivated. Not an attempt, so not a row: `notifications` records deliveries
      // that were tried, and a message nobody asked for was never one.
      continue
    }

    if (entry.kind === 'summary') {
      deliveries.push(
        await deliverNotification(
          { store, messenger },
          {
            // Null, per FR-139 and `db/schema/notify.ts`: recording this against an arbitrary one
            // of the runs it covers would be a lie.
            workflowId: null,
            event: summaryEvent,
            recipient,
            coalescedCount: entry.workflowIds.length,
            text: composeTickSummaryMessage({
              integrationName,
              workflowIds: entry.workflowIds,
              panel,
            }),
          },
        ),
      )
      continue
    }

    const subject = await store.readSubject(entry.workflowId)
    if (subject === undefined) {
      continue
    }

    deliveries.push(
      await deliverNotification(
        { store, messenger },
        {
          workflowId: entry.workflowId,
          event: summaryEvent,
          recipient,
          text: composeTickSummaryMessage({
            integrationName,
            workflowIds: [entry.workflowId],
            panel,
          }),
        },
      ),
    )
  }

  return deliveries
}
