import type { NotificationEvent, WorkflowState } from '@bluetel-ai/sisyphus-api/client'

import type { PendingTransition, TickStart } from './coalesce'
import type {
  DeliveryDependencies,
  NotificationDelivery,
  WorkflowNotificationResult,
} from './delivery'
import { notifyIntegrationTick, notifyWorkflowEvent } from './delivery'
import type { PanelLink } from './message'

/**
 * The seam a **job** notifies through (T177, FR-136, FR-139, FR-141).
 *
 * `./delivery.ts` is the delivery path and takes a store, a messenger and a panel URL. A job has
 * none of those and should acquire none of them: `reconcile.ts` would have to be handed a Slack
 * client to call `notifyWorkflowEvent` directly, and a job holding a Slack client is a job that can
 * be made to fail on a Slack outage — which is the FR-141 failure the delivery path was shaped to
 * make impossible. So this is the two-method port the jobs take, bound once per host in its
 * composition root: the control plane's `src/context.ts`, and the panel's
 * `src/server/machine-dependencies.ts` for the machine surface it mounts.
 *
 * `sisyphus-api` declares the same seam from the other side as `WorkflowEventEmitter` — one method,
 * a subset of `workflowEvent`'s notice, a return it does not read — so {@link WorkflowNotifier} is
 * assignable to it and a host wires this object straight into `SisyphusDependencies.notifier`. No
 * adapter, and no second opinion about who hears about a run.
 *
 * ## Which transitions notify, and which deliberately do not
 *
 * FR-136 is a closed list: a **terminal outcome**, **needs-attention**, **capped**,
 * **parked-resumable**, and a failed review iteration within an autonomous run. Every state change
 * in the control plane's `src/jobs/` was audited against it:
 *
 * | Where the state changes                     | To                       | Notifies                       |
 * | ------------------------------------------- | ------------------------ | ------------------------------ |
 * | `admit-workflow.ts` — admission             | `provisioning`, `queued` | no: neither is on FR-136's list |
 * | `start-workflow.ts` — provisioning          | no state write           | no                             |
 * | `teardown-workflow.ts` — release            | no state write           | no: it releases compute, the run was already terminal |
 * | `reconcile.ts` — the abandoned-run sweep    | `failed`                 | `workflow_failed`              |
 * | `reconcile.ts` — the abandoned-run sweep    | `parked_resumable`       | `workflow_parked_resumable`    |
 * | `integration-store.ts` — a tick's claim     | `queued`                 | one `integration_tick_summary` per owner, from the tick (FR-139) |
 *
 * A run reaching `succeeded`, `capped`, `cancelled` or `needs_attention` does so through
 * `reportTerminal` and the supervision procedures in `sisyphus-api`'s machine surface, which the
 * panel mounts. That surface emits through `SisyphusDependencies.notifier`, and what the panel
 * supplies is this port — so {@link notificationEventForState} stays written for the whole enum,
 * and the mapping is settled here for both hosts rather than once per caller.
 *
 * ## Nothing here throws, and the jobs still guard
 *
 * `deliverNotification` records every failure and returns; a Slack outage produces `failed` rows,
 * not an exception. The jobs nevertheless wrap their calls, because this is an *interface*: a
 * deployment may supply its own, and FR-141 has to hold against the seam rather than against the
 * implementation that happens to be behind it today.
 */

/**
 * The event a workflow reaching this state should announce, or `undefined` for the states FR-136
 * does not name.
 *
 * Written as a total map over {@link WorkflowState} rather than as a list of the interesting cases,
 * so a state added to the enum is a compile error here — which is where somebody has to decide
 * whether it is notifiable, rather than in Slack's absence six months later.
 */
const EVENT_BY_STATE: Readonly<Record<WorkflowState, NotificationEvent | undefined>> = {
  // Lifecycle states. A run being picked up is not news; FR-136 names outcomes and attention.
  queued: undefined,
  provisioning: undefined,
  running: undefined,
  paused: undefined,

  // FR-136's list, in full.
  succeeded: 'workflow_succeeded',
  failed: 'workflow_failed',
  capped: 'workflow_capped',
  cancelled: 'workflow_cancelled',
  needs_attention: 'workflow_needs_attention',
  parked_resumable: 'workflow_parked_resumable',
}

/**
 * The notification a state change calls for (FR-136).
 *
 * @param state - The state the workflow has just reached.
 * @returns The event to emit, or `undefined` when this transition is not notifiable.
 */
export const notificationEventForState = (state: WorkflowState): NotificationEvent | undefined =>
  EVENT_BY_STATE[state]

/** One workflow reached one state, and the run's audience should hear about it. */
export interface WorkflowEventNotice {
  readonly workflowId: string
  readonly event: NotificationEvent
  /** Transitions this message stands for. Defaults to the single `event`; see `./coalesce.ts`. */
  readonly pending?: readonly PendingTransition[]
  readonly now?: Date
}

/** One tick started these runs, for these owners (FR-139). */
export interface IntegrationTickNotice {
  readonly integrationName: string | null
  readonly starts: readonly TickStart[]
}

/**
 * **The port.** Two methods, both of which only send messages.
 *
 * Note what a holder of this cannot do: read a workflow, write one, or reach a database. That is
 * the same argument `./delivery.ts` makes about itself, carried one layer out to the jobs.
 */
export interface WorkflowNotifier {
  readonly workflowEvent: (notice: WorkflowEventNotice) => Promise<WorkflowNotificationResult>
  readonly integrationTick: (
    notice: IntegrationTickNotice,
  ) => Promise<readonly NotificationDelivery[]>
}

/** The store, the messenger, and where the panel is — assembled once, in `context.ts`. */
export interface WorkflowNotifierOptions extends DeliveryDependencies {
  readonly panel: PanelLink
}

/**
 * Bind the port to the delivery path.
 *
 * @param options - See {@link WorkflowNotifierOptions}.
 */
export const createWorkflowNotifier = (options: WorkflowNotifierOptions): WorkflowNotifier => {
  const { messenger, panel, store } = options

  return {
    workflowEvent: (notice) =>
      notifyWorkflowEvent({
        store,
        messenger,
        panel,
        workflowId: notice.workflowId,
        event: notice.event,
        ...(notice.pending === undefined ? {} : { pending: notice.pending }),
        ...(notice.now === undefined ? {} : { now: notice.now }),
      }),

    integrationTick: (notice) =>
      notifyIntegrationTick({
        store,
        messenger,
        panel,
        integrationName: notice.integrationName,
        starts: notice.starts,
      }),
  }
}
