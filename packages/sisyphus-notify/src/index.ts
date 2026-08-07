/**
 * The platform's notification layer — one Slack seam, one narrow store, and the delivery path
 * between them (T084, T085, FR-136 to FR-141).
 *
 * ## Why this is a package rather than a directory in the control plane
 *
 * It began as `apps/sisyphus-control-plane/src/notify/`, because the abandoned-run sweep was the
 * only thing that announced anything. It is not any more: `workflow_succeeded`, `workflow_capped`,
 * `workflow_cancelled`, `workflow_needs_attention` and `review_iteration_failed` are set on
 * `sisyphus-api`'s **machine surface**, and that surface is mounted by `apps/sisyphus-admin`. Two
 * apps therefore need one delivery path, and an app must not depend on another app — so the
 * delivery path is a package both depend on instead.
 *
 * The arrow to `@bluetel-ai/sisyphus-api` stays one-way: this package imports the schema and the
 * enums, and `sisyphus-api` imports nothing from here. What crosses back is a *port* —
 * `WorkflowEventEmitter`, declared there and structurally satisfied by {@link WorkflowNotifier}
 * here — so a host wires the object it already builds and neither side has to know the other.
 *
 * **The shape of this barrel is the FR-141 argument.** `./delivery.ts` is handed a
 * `NotificationStore` and a `SlackDirectMessenger` and nothing else; neither can write a workflow's
 * state or outcome, so a Slack outage cannot turn a succeeded run into a failed one. That is a
 * property of the types rather than of the calling convention — see the module comment in
 * `./delivery.ts`.
 *
 * Every seam ships with a recording fake, exported here so a host's tests take the same one rather
 * than inventing a stub apiece — the pattern the control plane's `src/aws/` established. **No
 * module in this package constructs a Slack client or a database handle**, so importing this barrel
 * reaches no workspace and no server: the one place a `WebClient` is built is the composition root
 * of whichever app is doing the notifying.
 *
 * Consumers import this barrel, never a module underneath it.
 */

export {
  COALESCE_WINDOW_MS,
  NOTIFICATION_DELIVERY_BUDGET_MS,
  NOTIFY_TICK_MS,
  planIntegrationTickSummaries,
  planWorkflowDeliveries,
  SLACK_ROUND_TRIP_ALLOWANCE_MS,
  TICK_SUMMARY_THRESHOLD,
  worstCaseDeliveryLatencyMs,
} from './coalesce'
export type {
  CoalescedDelivery,
  DeferredDelivery,
  PendingTransition,
  TickIndividualPlan,
  TickPlanEntry,
  TickStart,
  TickSummaryPlan,
  WorkflowNotificationPlan,
} from './coalesce'

export { deliverNotification, notifyIntegrationTick, notifyWorkflowEvent } from './delivery'
export type {
  DeliveryDependencies,
  DeliveryRequest,
  NotificationDelivery,
  NotifyIntegrationTickOptions,
  NotifyWorkflowEventOptions,
  WorkflowNotificationResult,
} from './delivery'

export {
  composeTickSummaryMessage,
  composeWorkflowMessage,
  TICK_SUMMARY_LINK_LIMIT,
  workflowDetailUrl,
} from './message'
export type { PanelLink, TickSummaryInput, WorkflowMessageInput } from './message'

export { createNotificationStore } from './notification-store'
export type {
  AudienceMember,
  AudienceRelation,
  NotificationAttempt,
  NotificationReader,
  NotificationStore,
  NotificationSubject,
  RecentDelivery,
} from './notification-store'

export {
  createFakeNotificationStore,
  fakeAudienceMember,
  fakeSubject,
} from './notification-store-fake'
export type { FakeNotificationStore, FakeNotificationStoreOptions } from './notification-store-fake'

/**
 * The port a **job** notifies through, and its recording fake.
 *
 * `notifyWorkflowEvent` is the delivery path and needs a store, a messenger and a panel URL;
 * `WorkflowNotifier` is the two-method seam a job takes instead, so no job acquires a Slack client
 * on the way to announcing a state change (T177, FR-141).
 */
export { createWorkflowNotifier, notificationEventForState } from './notifier'
export type {
  IntegrationTickNotice,
  WorkflowEventNotice,
  WorkflowNotifier,
  WorkflowNotifierOptions,
} from './notifier'

export { createFakeWorkflowNotifier } from './notifier-fake'
export type {
  FakeWorkflowNotifier,
  FakeWorkflowNotifierOptions,
  RecordedTickNotice,
  RecordedWorkflowNotice,
} from './notifier-fake'

export { selectRecipients, unnotifiableRecipients, wantsEvent } from './recipients'
export type { NotificationRecipient } from './recipients'

export {
  createWebApiSlackMessenger,
  isUnnotifiableSlackError,
  SlackDeliveryError,
  UNNOTIFIABLE_SLACK_ERRORS,
} from './slack'
export type {
  SlackConversationOpenResult,
  SlackDirectMessenger,
  SlackPostMessageResult,
  SlackWebApiClient,
} from './slack'

export { createFakeSlackMessenger } from './slack-fake'
export type {
  FakeSlackMessenger,
  FakeSlackMessengerOptions,
  RecordedSlackMessage,
} from './slack-fake'
