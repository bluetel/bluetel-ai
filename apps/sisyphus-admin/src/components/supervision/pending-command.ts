import type { WorkflowState } from '@bluetel-ai/sisyphus-api/client'
import { formatTimestamp } from '@sisyphus-admin/components/admin'
import type { RouterOutputs } from '@sisyphus-admin/trpc'

import type { CorrectionReadout } from './correction-list'
import type { PendingSupervisionCommand, SupervisionCommandName } from './supervision-status'
import { supervisionStatus } from './supervision-status'

/**
 * **When a queued command stops being a request (T208, FR-015, FR-049, SC-003).**
 *
 * `./supervision-status.ts` holds the rule that the panel may only say "paused" once the executor
 * has acknowledged. That rule is only worth anything if something *retires* the request at the
 * right moment, and this module is that something.
 *
 * The mutation resolving is **not** the moment. `workflow.pause` returns as soon as a
 * `supervision_commands` row is written under the workflow row lock — it does not touch
 * `workflows.state`, deliberately, and `packages/sisyphus-api/src/server/workflow/supervision.ts`
 * says so in as many words. The agent is still working when that promise settles. The moment is
 * the executor's acknowledgement, which is visible to the panel as exactly one thing: the state
 * `workflow.byId` now reports. So {@link isCommandAcknowledged} is a function of the recorded
 * state and nothing else, and the panel re-reads that state rather than concluding anything from
 * its own mutation.
 *
 * The consequence is that the request cannot be retired early even by mistake. There is no code
 * path from `onSuccess` to "paused": the success handler can only *start* a wait.
 */

/** What `workflow.pause`, `workflow.resume` and `workflow.stop` all answer with. */
export type SupervisionCommandResult = RouterOutputs['workflow']['pause']

/** What `workflow.corrections` answers with. Typed from the router, never mirrored by hand. */
export type CorrectionRecords = RouterOutputs['workflow']['corrections']

/**
 * The shape shared by every supervision request's answer: it was applied, or it was refused with an
 * already-finished explanation (FR-081). Both {@link SupervisionCommandResult} and the correction
 * mutation's result satisfy it, which is what lets one helper read either.
 */
type SettledRequest =
  | { readonly applied: true }
  | { readonly applied: false; readonly explanation: string }

/**
 * Has the executor acknowledged this command?
 *
 * Expressed through {@link supervisionStatus} with **no pending command**, so the answer is derived
 * from the same reading of `workflows.state` the panel renders — there is no second table of state
 * names here that could drift from that one.
 *
 * - `pause` — acknowledged when the run is recorded `paused`, or `parked_resumable` when the pause
 *   went straight on to release its compute (FR-050, US2 §4).
 * - `resume` — acknowledged when the run is running again. A resume out of `parked_resumable` goes
 *   back through `provisioning`, which is why this is "no longer held" rather than a literal
 *   `running`.
 * - `stop` — acknowledged only by a terminal state. The acknowledgement itself moves nothing:
 *   `reportTerminal` writes `cancelled` with the consumption attached, so a run that has stopped is
 *   a run that has finished and nothing short of that may be rendered as one.
 *
 * A terminal state retires any command, because a run that has ended will not be collecting one.
 */
export const isCommandAcknowledged = (options: {
  readonly command: SupervisionCommandName
  readonly workflowState: WorkflowState
}): boolean => {
  const recorded = supervisionStatus({ workflowState: options.workflowState })

  if (recorded === 'finished') {
    return true
  }

  if (options.command === 'pause') {
    return recorded === 'paused' || recorded === 'parked'
  }

  if (options.command === 'resume') {
    return recorded !== 'paused' && recorded !== 'parked'
  }

  return false
}

/**
 * The command the panel is waiting on after a request settled.
 *
 * Three answers, and the two that are not "the one just made" are the interesting ones:
 *
 * - **Refused as already finished** (FR-081) — nothing was queued, so nothing is awaited. The row
 *   was written `rejected` and no executor will ever collect it.
 * - **Superseded on arrival** — an uncollected `stop` was already queued, so this request was
 *   recorded `superseded` and will never be applied (`./supersession.ts`, rule 3). The panel keeps
 *   waiting on what it was already waiting on; claiming a pause is queued when the server has
 *   already marked it dead would be the same lie one step earlier.
 * - Otherwise the new command, stamped now, so the card can say how long it has been waiting.
 *
 * @param options.held - What the panel was already waiting on, if anything.
 * @param options.requestedAt - `Date.now()` when the request was made.
 */
export const nextPendingCommand = (options: {
  readonly held: PendingSupervisionCommand | undefined
  readonly command: SupervisionCommandName
  readonly result: SupervisionCommandResult
  readonly requestedAt: number
}): PendingSupervisionCommand | undefined => {
  if (!options.result.applied) {
    return undefined
  }

  if (options.result.outcome === 'superseded') {
    return options.held
  }

  if (options.result.outcome === 'acknowledged') {
    // Applied by the platform itself, with no executor in the loop: a `stop` against a run waiting
    // for an agent credential is terminal by the time the mutation answers (003/FR-027). There is
    // nothing to await, and showing "stop requested" for a run that has already stopped would
    // invite somebody to press it again.
    return undefined
  }

  return { command: options.command, requestedAt: options.requestedAt }
}

/**
 * The server's already-finished sentence, verbatim, or nothing when the request was applied.
 *
 * Verbatim because it names *how* the run ended, and a panel that rewrote it into "this run has
 * finished" would drop the part the person needed.
 */
export const alreadyFinishedExplanation = (result: SettledRequest): string | undefined =>
  result.applied ? undefined : result.explanation

/**
 * The reason a request was overtaken before it was written, if it was.
 *
 * Rendered rather than swallowed: the person pressed Pause and no pause will happen, and the only
 * other signal is a status chip that says something about a stop they may not have issued.
 */
export const supersededNotice = (result: SupervisionCommandResult): string | undefined => {
  if (!result.applied) {
    return undefined
  }

  return result.supersededReason ?? undefined
}

/**
 * The corrections as the list renders them.
 *
 * Every row, including the ones that did not land — `./correction-list.tsx` states why filtering
 * them would be the silent drop with extra steps (FR-049, SC-004). The timestamp is formatted here
 * because the list holds no clock.
 */
export const toCorrectionReadouts = (records: CorrectionRecords): readonly CorrectionReadout[] =>
  records.map((record) => ({
    id: record.id,
    sequence: record.sequence,
    body: record.body,
    outcome: record.deliveryOutcome,
    failureReason: record.failureReason,
    submittedAt: formatTimestamp(record.submittedAt),
  }))
