/**
 * Moving a ticket — the one delivery action Sisyphus performs on a customer's system of record
 * (FR-057, FR-060, FR-061, FR-063, FR-076).
 *
 * ## Why this is its own module and not a method on the forge
 *
 * `src/delivery` cannot move a ticket. That is not an omission: the {@link
 * import('../delivery').Forge} port has no method that could, which is what makes FR-060's
 * "delivery ownership stays with the initiating engineer" a shape rather than a rule. A delegated
 * run reaches for the delivery path and finds nothing there to move a ticket with, and
 * `PullRequestDelivery.ticketTransitioned` is the literal `false` recording that it was left alone
 * deliberately rather than missed.
 *
 * So the capability lives here, in the directory that owns the **autonomous** and **review**
 * workflow types — the two FR-061 and FR-063 give a ticket transition to — and it is reachable
 * only through {@link transitionTicket}.
 *
 * ## Sisyphus has no vocabulary for ticket states
 *
 * `toState` is free text and there is no enumeration of it anywhere in this project. There cannot
 * be: one client's board goes to `In Review`, another's to `Peer Review`, another's has no review
 * column at all and expects the ticket to stay put. A constant here would be one client's board
 * imposed on every other, which is exactly what FR-057 forbids. The state comes from the skill,
 * through a {@link SkillDirective}, and {@link requireDirective} refuses to move anything without
 * one.
 *
 * ## Moved at most once
 *
 * A transition is an external action with a customer-visible duplicate: a ticket that bounces
 * `In Progress → In Review → In Progress → In Review` because a report was retried reads, on the
 * board, as a run that could not make up its mind. It therefore goes through
 * `performExternalAction` on an identity of `(run, ticket, target state)` — the target state is in
 * the key because a run legitimately moves the same ticket more than once across iterations, and a
 * key of the ticket alone would swallow every move after the first as a replay.
 */

import type { ExternalActionDisposition, ExternalActionLedger } from '../delivery'
import { EXTERNAL_ACTION_KEY_SEPARATOR, performExternalAction } from '../delivery'

import type { SkillDirective } from './skill-directive'
import { requireDirective } from './skill-directive'

/** The action name in the idempotency key. */
export const TICKET_TRANSITION_ACTION = 'ticket-transition'

/** What a transition looks like once it has happened, whoever performed it. */
export interface TicketTransitionRef {
  readonly ticketReference: string
  /** The state the ticket is now in, as the connector reports it. */
  readonly toState: string
}

/**
 * The port a connector satisfies.
 *
 * `find` is optional and supplying it is what closes the retry gap: a connector that can be asked
 * "is this ticket already there?" cannot produce a duplicate transition after a lost response.
 */
export interface TicketPort {
  readonly transition: (input: {
    readonly ticketReference: string
    readonly toState: string
    readonly idempotencyKey: string
  }) => Promise<TicketTransitionRef>
  readonly find?: (input: {
    readonly ticketReference: string
    readonly toState: string
  }) => Promise<TicketTransitionRef | undefined>
}

/** One transition, as it is recorded on the workflow. */
export interface TicketTransitionRecord {
  readonly ticketReference: string
  readonly toState: string
  readonly disposition: ExternalActionDisposition
  readonly idempotencyKey: string
  /** The skill and digest that prescribed it (FR-059). */
  readonly directive: SkillDirective
}

/**
 * The record of a ticket **deliberately** left alone.
 *
 * FR-060's whole point is the difference between "no transition was performed" and "no transition
 * was attempted", and a missing field expresses neither. A delegated run and a review workflow
 * whose skill prescribes no move both produce one of these, so the panel can say the ticket was
 * untouched on purpose.
 */
export interface TicketUntouchedRecord {
  readonly moved: false
  readonly ticketReference: string
  readonly reason: string
}

export const ticketUntouched = (
  ticketReference: string,
  reason: string,
): TicketUntouchedRecord => ({ moved: false, ticketReference, reason })

export interface TransitionTicketInput {
  readonly workflowId: string
  readonly ticketReference: string
  /**
   * Where the skill said to move it. Never defaulted — a blank state is a skill that did not say,
   * and a run that moved a ticket anyway would be inventing a board column.
   */
  readonly toState: string
  readonly directive: SkillDirective | undefined
  readonly ticket: TicketPort
  readonly ledger: ExternalActionLedger<TicketTransitionRef>
}

/**
 * Move a ticket, at most once, and only because a skill said to.
 *
 * @param input - The run, the ticket, the state the skill named, and the port.
 * @returns The transition and how it was arrived at.
 * @throws When no skill prescribed the move, or when the skill named no state.
 */
export const transitionTicket = async (
  input: TransitionTicketInput,
): Promise<TicketTransitionRecord> => {
  const directive = requireDirective(
    input.directive,
    `move ${input.ticketReference}`,
    input.directive?.step ?? 'ticket transition',
  )

  const toState = input.toState.trim()

  if (toState === '') {
    throw new Error(
      `The ${directive.step} step will not move ${input.ticketReference}: ` +
        `${directive.skillName} names no state to move it to. Sisyphus has no ticket states of ` +
        'its own (FR-057), so the workflow stops here rather than choosing a column.',
    )
  }

  const outcome = await performExternalAction(input.ledger, {
    identity: {
      action: TICKET_TRANSITION_ACTION,
      workflowId: input.workflowId,
      target: [input.ticketReference, toState],
      kind: 'ticket_transitioned',
    },
    ...(input.ticket.find === undefined
      ? {}
      : {
          find: async (): Promise<TicketTransitionRef | undefined> =>
            input.ticket.find?.({ ticketReference: input.ticketReference, toState }),
        }),
    perform: async (idempotencyKey): Promise<TicketTransitionRef> =>
      input.ticket.transition({
        ticketReference: input.ticketReference,
        toState,
        idempotencyKey,
      }),
  })

  return {
    ticketReference: outcome.result.ticketReference,
    toState: outcome.result.toState,
    disposition: outcome.disposition,
    idempotencyKey: outcome.key,
    directive,
  }
}

/** The key a transition is deduplicated on, for a caller that needs to name it in a report. */
export const ticketTransitionKey = (input: {
  readonly workflowId: string
  readonly ticketReference: string
  readonly toState: string
}): string =>
  [TICKET_TRANSITION_ACTION, input.workflowId, input.ticketReference, input.toState].join(
    EXTERNAL_ACTION_KEY_SEPARATOR,
  )
