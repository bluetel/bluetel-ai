/**
 * **The ticket connector this executor does not have (T196, FR-061, FR-063, FR-076).**
 *
 * `TicketPort` is the one port of T196 that is **not** implemented against anything, and that is a
 * deliberate outcome rather than work left undone. It is worth being precise about what is missing,
 * because "wire up Jira" is not it.
 *
 * ## Two things are missing, and neither is a client library
 *
 * **There is no ticket to move.** `job-envelope.ts` carries the workspace, the job spec and the
 * assembled prompt. It carries no ticket reference — `workflows.ticket_reference` exists on the
 * row, and the control plane's envelope does not put it in user data — and the machine surface
 * exposes no procedure to read one back. So even a perfect connector would have nothing to address.
 *
 * **There is no credential and no endpoint.** A ticket tracker is reached with the client's own
 * credential, installed by their setup bundle (FR-043, FR-075), against the client's own instance
 * of whichever tracker they use. Which tracker, at which URL, under which credential, is
 * per-client configuration that reaches this instance through the bundle and is not described
 * anywhere the executor can read. `packages/sisyphus-integrations` speaks to Jira from the
 * **control plane**, holding credentials the executor is specifically forbidden from having
 * (FR-005, FR-006, FR-036) — so it is not the thing to reach for from here either.
 *
 * ## So the port refuses, loudly, rather than succeeding quietly
 *
 * {@link createRefusingTicketPort} rejects every transition with a sentence naming what is absent.
 * The three alternatives were all considered and all are worse:
 *
 * - **A port that returns a plausible `TicketTransitionRef`** records a transition against the
 *   workflow and reports a run that moved a ticket nobody moved. That is the exact failure this
 *   codebase refuses everywhere else: a run reporting success having done nothing is strictly worse
 *   than one that says what it is missing.
 * - **A port that silently does nothing** is the same thing with a quieter lie, and FR-063's
 *   "perform only the transition the skill prescribes" cannot be distinguished from "perform
 *   nothing" afterwards.
 * - **Supplying no port at all** is nearly right and is what a review run already gets today:
 *   `applyReviewOutcome` throws when the skill prescribes a move and there is no connector, which
 *   is loud and correct. But `runAutonomousWorkflow`'s `moveTicketIfPrescribed` returns `undefined`
 *   when the port is absent, so an autonomous run whose `sisyphus-review` prescribes "return the
 *   ticket to in progress" would carry on **silently**. Supplying this makes that case loud the
 *   moment a ticket reference exists to trigger it.
 *
 * ## What has to happen for this to become an implementation
 *
 * Three things, in this order, and none of them is in this file: the envelope has to carry the
 * workflow's ticket reference; the setup bundle contract has to state where a tracker's endpoint
 * and credential land on the instance; and a connector has to be written against that. Until the
 * first exists there is nothing for the third to do, which is why this is a refusal and not a stub
 * waiting to be filled in.
 */

import type { TicketPort } from '../workflows'

/** The refusal, in one sentence a terminal report can carry. */
export const noTicketConnectorError = (input: {
  readonly ticketReference: string
  readonly toState: string
}): Error =>
  new Error(
    `a skill prescribed moving ${input.ticketReference} to "${input.toState}", and this instance ` +
      'has no ticket connector to move it with: the job envelope carries no ticket reference ' +
      '(FR-036) and no tracker endpoint or credential is described anywhere the executor can read ' +
      '(FR-043, FR-075). The workflow stops here. Nothing was transitioned, and nothing was ' +
      'recorded as though it had been.',
  )

/**
 * A ticket port that performs no transition and says why.
 *
 * `find` is deliberately not supplied. Its whole purpose is to close the retry gap by answering "is
 * this ticket already there?", and a connector that cannot move a ticket cannot answer that either
 * — an implementation returning `undefined` would report "no, it is not there" about a system it
 * never asked.
 *
 * @returns A `TicketPort` whose every transition rejects.
 */
export const createRefusingTicketPort = (): TicketPort => ({
  transition: async (input) =>
    Promise.reject(
      noTicketConnectorError({ ticketReference: input.ticketReference, toState: input.toState }),
    ),
})
