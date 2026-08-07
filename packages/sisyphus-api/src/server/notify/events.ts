import type { NotificationEvent, ReviewVerdict, TerminalOutcome } from '../../enums'

/**
 * Which of this package's writes are notifiable, and which deliberately are not (FR-136).
 *
 * FR-136 is a closed list: a **terminal outcome**, **needs-attention**, **capped**,
 * **parked-resumable**, and a failed review iteration within an autonomous run. The control plane
 * already answers the half of that list its own jobs write — `workflow_failed` and
 * `workflow_parked_resumable` from the abandoned-run sweep — through
 * `apps/sisyphus-control-plane/src/notify/notifier.ts`. The other half is written **here**, on the
 * machine surface, and these two maps are that half stated once.
 *
 * ## Why maps rather than `if` statements at the call sites
 *
 * Both are written as total records over their enum rather than as a list of the interesting
 * cases, exactly as `notificationEventForState` is on the control plane's side. An outcome added
 * to {@link TerminalOutcome} is then a **compile error in this file** — which is where somebody
 * has to decide whether it is notifiable, rather than in Slack's absence six months later. A
 * `switch` with a `default`, or a call site that tested `outcome === 'succeeded'`, would take the
 * new value silently and the run would end in silence.
 *
 * ## The duplication with the control plane is not accidental
 *
 * `EVENT_BY_OUTCOME` and the control plane's `EVENT_BY_STATE` agree, and neither imports the
 * other, because this package must not depend on an app. What keeps them honest is that the
 * relationship is mechanical — every terminal outcome has a `workflow_<outcome>` event, asserted
 * in `src/enums/notification-event.test.ts` — and that both are total maps, so neither can drift
 * by omission. The colocated test asserts the naming rule here too, so the two derive from the
 * same stated fact rather than from one having been copied.
 */

/**
 * The event a run reaching this outcome announces.
 *
 * Total, and every member is populated: unlike the control plane's state map there is no
 * non-notifiable case, because every value of {@link TerminalOutcome} is on FR-136's list by
 * construction — reaching one *is* reaching a terminal outcome.
 */
const EVENT_BY_OUTCOME: Readonly<Record<TerminalOutcome, NotificationEvent>> = {
  succeeded: 'workflow_succeeded',
  failed: 'workflow_failed',
  capped: 'workflow_capped',
  cancelled: 'workflow_cancelled',
  needs_attention: 'workflow_needs_attention',
  parked_resumable: 'workflow_parked_resumable',
}

/**
 * The notification a terminal report calls for (FR-136).
 *
 * @param outcome - The outcome the run has just reached.
 */
export const notificationEventForOutcome = (outcome: TerminalOutcome): NotificationEvent =>
  EVENT_BY_OUTCOME[outcome]

/**
 * The event a review verdict announces, or `undefined` when there is nothing to say.
 *
 * A **passing** iteration is not news — FR-136 names the failed one, and a message per pass of a
 * three-pass loop is precisely the burst FR-139 exists to prevent. So `pass` maps to `undefined`
 * rather than being absent from the map: the reader can see that the silence was chosen.
 */
const EVENT_BY_VERDICT: Readonly<Record<ReviewVerdict, NotificationEvent | undefined>> = {
  pass: undefined,
  fail: 'review_iteration_failed',
}

/**
 * The notification one recorded iteration calls for (FR-136).
 *
 * @param verdict - The verdict the executor reported for this pass.
 * @returns The event to emit, or `undefined` when this pass is not notifiable.
 */
export const notificationEventForVerdict = (
  verdict: ReviewVerdict,
): NotificationEvent | undefined => EVENT_BY_VERDICT[verdict]
