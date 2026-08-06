/**
 * The control plane's notification layer — one Slack seam, one narrow store, and the delivery path
 * between them (T084, T085, FR-136 to FR-141).
 *
 * **The shape of this barrel is the FR-141 argument.** `./delivery.ts` is handed a
 * `NotificationStore` and a `SlackDirectMessenger` and nothing else; neither can write a workflow's
 * state or outcome, so a Slack outage cannot turn a succeeded run into a failed one. That is a
 * property of the types rather than of the calling convention — see the module comment in
 * `./delivery.ts`.
 *
 * Every seam ships with a recording fake, exported here so other jobs' tests take the same one
 * rather than inventing a stub apiece — the pattern `../aws/` established. **No module in this
 * directory constructs a Slack client or a database handle**, so importing this barrel reaches no
 * workspace and no server.
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
