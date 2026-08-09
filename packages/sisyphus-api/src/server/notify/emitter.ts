import type { NotificationEvent } from '../../enums'

/**
 * **The seam this package notifies through (FR-136, FR-140, FR-141).**
 *
 * Four of FR-136's events — `workflow_succeeded`, `workflow_capped`, `workflow_cancelled` and
 * `workflow_needs_attention` — plus `review_iteration_failed` are set by the machine surface in
 * this package, not by a control-plane job. They therefore need a way out of here, and there are
 * only three shapes available:
 *
 * 1. **Import the control plane's delivery path.** Impossible and undesirable:
 *    `@bluetel-ai/sisyphus-api` is a dependency *of* `apps/sisyphus-control-plane`, so the arrow
 *    cannot be reversed, and a package that reached into an app would be unusable from the other
 *    two consumption modes.
 * 2. **Deliver Slack from here.** That puts a Slack client on the executor's report-back path —
 *    the exact arrangement `apps/sisyphus-control-plane/src/notify/notifier.ts` refuses for its
 *    jobs, and for the same reason: a run's terminal outcome would then be recordable only while
 *    Slack is up, which is the FR-141 failure stated as an architecture.
 * 3. **Declare a port and let the host inject one.** This.
 *
 * So {@link WorkflowEventEmitter} is the mirror image of the control plane's `WorkflowNotifier`:
 * the same argument, made from the other side of the dependency. It is **structurally satisfied**
 * by that interface — one method, a subset of its parameter's fields, a return this file does not
 * look at — so the host wires the object it already builds rather than writing an adapter.
 *
 * ## What a holder of this cannot do
 *
 * Read a workflow, write one, or reach a database. A notifier handed to
 * {@link emitWorkflowEvent} is given a workflow **id** and an event name; whose Slack account that
 * reaches, whether they have one (FR-140), what the message says and whether the attempt was
 * recorded (FR-141) are all decisions on the far side of the seam, where the audience and the
 * delivery record live. This package deliberately holds none of that: doing so would put a second
 * implementation of "who should hear about this run" in a second app.
 *
 * ## Nothing here throws, and that is the requirement
 *
 * FR-141: *a delivery failure MUST NOT alter the workflow's own state or outcome.*
 * {@link emitWorkflowEvent} catches everything and answers with a result. It is not defensive
 * programming — the seam is an *interface*, a deployment may supply its own implementation, and
 * FR-141 has to hold against the seam rather than against whatever happens to be behind it today.
 *
 * The two disciplines that make that true are at the call sites and are stated there: the emit
 * happens **after** the state transaction has committed, and it is never inside it. An emit inside
 * the transaction would roll the outcome back on a Slack outage even with the throw swallowed,
 * because the notifier's own database work would be enlisted in it.
 */

/** One workflow reached one notifiable point, and its audience should hear about it. */
export interface WorkflowEventNotification {
  readonly workflowId: string
  readonly event: NotificationEvent
}

/**
 * **The port.** One method, deliberately.
 *
 * The return type is `Promise<unknown>` rather than `Promise<void>` so an implementation that
 * answers with a delivery record — as the control plane's `WorkflowNotifier.workflowEvent` does —
 * is assignable without an adapter. Nothing in this package reads it: what came back is a fact
 * about delivery, and delivery is not this package's business.
 */
export interface WorkflowEventEmitter {
  readonly workflowEvent: (notification: WorkflowEventNotification) => Promise<unknown>
}

/** What an attempt did, for a caller that wants to say so. Never a reason to fail the operation. */
export interface WorkflowEventEmission {
  /** True only when a notifier was wired **and** its call resolved. */
  readonly emitted: boolean
  /** Whatever the notifier threw, kept rather than discarded so a host can log it. */
  readonly failure?: unknown
}

/**
 * Announce a notifiable transition, **after** it has been committed (FR-136, FR-141).
 *
 * @param emitter - The wired notifier, or `undefined` in a deployment that has none. Absent is a
 *   silent no-op rather than an error: a platform whose Slack app has not been installed yet must
 *   still be able to finish a workflow. Refusing by default is the right shape only where the
 *   refusal is *survivable* — an unwired notifier withholds one message and breaks nothing
 *   downstream, which is exactly why silence is the safe choice here. A gate on the one path an
 *   operator needs in order to run anything at all does not get that luxury: refuse by default
 *   there and "safe default" and "product inoperable" are the same state.
 * @param notification - The workflow and the event.
 * @returns What happened. Callers may ignore it; none of them may throw on it.
 */
export const emitWorkflowEvent = async (
  emitter: WorkflowEventEmitter | undefined,
  notification: WorkflowEventNotification,
): Promise<WorkflowEventEmission> => {
  if (emitter === undefined) {
    return { emitted: false }
  }

  try {
    await emitter.workflowEvent(notification)
    return { emitted: true }
  } catch (failure) {
    // Swallowed on purpose, and this is the whole of FR-141 in one statement: the state change
    // this announces is already committed, and rethrowing here would surface a Slack outage to the
    // executor as a failed `reportTerminal`, which it would then retry forever.
    return { emitted: false, failure }
  }
}
