/**
 * **The run's external-action ledgers, built once against the machine surface (FR-076, FR-077).**
 *
 * `delivery/external-action.ts` can now claim an action durably, but only through a ledger that was
 * given a recorder. A ledger built without one is a `Map` — correct for one process, empty after a
 * re-provision, and indistinguishable at the call site from a durable one. So the choice of which
 * kind a run gets must not be made four times, in four delivery steps, by whoever happens to be
 * constructing a ledger there. It is made here, once, from the client the assembly already holds.
 *
 * ## Why four, and why not one
 *
 * A ledger is typed by what its action *produces* — a `PullRequestDelivery`, a
 * `TicketTransitionRef` — because the in-memory half replays that value. One ledger of
 * `TResult = unknown` would give the replay path nothing to hand back without a cast at every use.
 * They are cheap: four `Map`s and one shared recorder, and the durable rows they claim are keyed by
 * the action rather than by which ledger asked, so nothing depends on the split.
 *
 * ## Reached through `WorkflowPortsContext`
 *
 * The ports factory is where the agent-facing ports are built, and it is where the workflow inputs
 * get their ledgers. Handing it these means a factory has to go out of its way to end up with a
 * non-durable ledger, rather than getting one by writing the obvious thing.
 */

import type { ExternalActionLedger, ExternalActionRecorder, PullRequestDelivery } from '../delivery'
import { createExternalActionLedger } from '../delivery'
import type { IntegrationStepRef, ReviewCommentRef, TicketTransitionRef } from '../workflows'

/** One ledger per thing a run performs outside the platform. */
export interface RunExternalActionLedgers {
  readonly pullRequest: ExternalActionLedger<PullRequestDelivery>
  readonly ticket: ExternalActionLedger<TicketTransitionRef>
  readonly integration: ExternalActionLedger<IntegrationStepRef>
  readonly reviewComment: ExternalActionLedger<ReviewCommentRef>
}

/**
 * Build the run's ledgers, all backed by the same durable claim.
 *
 * @param recorder - The machine surface. `MachineSurfaceClient` satisfies it structurally.
 * @returns Four ledgers, every one of them durable.
 */
export const createRunExternalActionLedgers = (
  recorder: ExternalActionRecorder,
): RunExternalActionLedgers => ({
  pullRequest: createExternalActionLedger<PullRequestDelivery>({ recorder }),
  ticket: createExternalActionLedger<TicketTransitionRef>({ recorder }),
  integration: createExternalActionLedger<IntegrationStepRef>({ recorder }),
  reviewComment: createExternalActionLedger<ReviewCommentRef>({ recorder }),
})
