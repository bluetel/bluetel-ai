/**
 * **Delivering a correction into the live conversation (T093, FR-044, FR-049, SC-004).**
 *
 * A correction is an additional user turn on the agent's input stream. R1 chose NDJSON-on-stdin
 * precisely so this costs a line on a pipe rather than a restart: the process stays alive, the
 * conversation is never torn down and rebuilt, and only the guidance changes.
 *
 * ## Exactly once, in submission order
 *
 * **Order** comes from `sequence`, allocated by the API under the workflow row lock. This loop sorts
 * by it and delivers strictly serially — one `sendTurn` in flight at a time, and never advancing to
 * the next correction until the current one has been acknowledged. Firing two concurrently would
 * make submission order and delivery order two different things over a transport whose scheduling
 * spike S1 explicitly did **not** observe.
 *
 * **Once** comes from the queue: the API returns only `pending` rows, and acknowledging moves a row
 * out of `pending` with a conditional update that matches at most once. A retried acknowledgement
 * (FR-047 has the executor retrying whenever the API is unreachable) changes nothing.
 *
 * The honest residual is stated in the API's `corrections.ts` and repeats here: an instance
 * destroyed between delivering a turn and acknowledging it leaves the row pending, so the restored
 * instance delivers it again. At-least-once across an instance loss is the deliberate direction —
 * FR-049 forbids a correction being silently dropped and says nothing against one arriving twice.
 * Acknowledging *before* delivering would swap a visible duplicate for an invisible drop.
 *
 * ## Failing visibly
 *
 * `AgentAdapter.sendTurn` returns `AgentTurnDelivery { acknowledged, latencyMs }` rather than
 * `Promise<void>`, and that return type is the whole reason this module can tell three outcomes
 * apart instead of two:
 *
 * - **delivered** — the agent echoed the turn back (`--replay-user-messages`);
 * - **unconfirmed** — the write succeeded and nothing confirmed receipt. Reported as `failed` with a
 *   reason that says exactly that. It is *not* rounded up to delivered, because a correction the
 *   user believes landed and which did not is the specific failure SC-004 is about;
 * - **failed** — the write itself was refused, so the reason is the adapter's.
 *
 * All three are acknowledged. Nothing is dropped, and nothing is retried silently in a way that
 * would turn one correction into two turns in the conversation.
 */

import type { AgentTurnDelivery } from '../agent'

/** One correction as the machine surface returns it. */
export interface CollectedCorrection {
  readonly id: string
  readonly sequence: number
  readonly body: string
}

/** The outcomes the machine surface accepts. */
export type CorrectionDeliveryOutcome = 'delivered' | 'failed' | 'rejected'

/** What the executor sends back for one correction. */
export interface CorrectionAcknowledgement {
  readonly correctionId: string
  readonly outcome: CorrectionDeliveryOutcome
  readonly failureReason?: string
}

/** The machine-surface calls this loop makes. Injected, so the loop needs no network to be tested. */
export interface CorrectionTransport {
  readonly pullPendingCorrections: () => Promise<readonly CollectedCorrection[]>
  readonly acknowledgeCorrection: (acknowledgement: CorrectionAcknowledgement) => Promise<void>
}

/**
 * The one thing this loop needs from the agent.
 *
 * Narrowed to `sendTurn` on purpose: a correction path holding the whole adapter is a correction
 * path one edit away from being able to stop the agent, and nothing here should be able to.
 */
export interface CorrectionSender {
  readonly sendTurn: (body: string, options?: { timeoutMs?: number }) => Promise<AgentTurnDelivery>
}

/** What happened to one correction. */
export interface DeliveredCorrection {
  readonly correctionId: string
  readonly sequence: number
  readonly outcome: CorrectionDeliveryOutcome
  /** True only when the agent echoed the turn back. */
  readonly acknowledgedByAgent: boolean
  readonly latencyMs: number | null
  readonly failureReason?: string
}

/** What one pass over the correction queue did. */
export interface CorrectionCycleResult {
  readonly collected: number
  readonly delivered: readonly DeliveredCorrection[]
  /** True when a delivery failed and the rest of the batch was left for the next pass. */
  readonly haltedEarly: boolean
}

export interface CorrectionDelivererOptions {
  readonly transport: CorrectionTransport
  readonly agent: CorrectionSender
  /** Passed to `sendTurn`; the adapter's own default applies when this is omitted. */
  readonly sendTurnTimeoutMs?: number
}

export interface CorrectionDeliverer {
  readonly cycle: () => Promise<CorrectionCycleResult>
}

/** Corrections in submission order. Exported so the ordering rule can be checked on its own. */
export const inSequenceOrder = <TCorrection extends { readonly sequence: number }>(
  corrections: readonly TCorrection[],
): readonly TCorrection[] => [...corrections].sort((left, right) => left.sequence - right.sequence)

/** The reason recorded when the turn was written but the agent never echoed it back. */
export const UNCONFIRMED_DELIVERY_REASON =
  'the turn was written to the agent but never acknowledged, so it cannot be reported as delivered'

const describeFailure = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Build the deliverer.
 *
 * One `cycle` per pass rather than an internal loop: corrections are polled on the **same** loop as
 * supervision commands (executor-protocol.md), so the caller owns the interval and the two queues
 * cannot drift into two different rhythms.
 */
export const createCorrectionDeliverer = (
  options: CorrectionDelivererOptions,
): CorrectionDeliverer => {
  const { transport, agent } = options

  const deliverOne = async (correction: CollectedCorrection): Promise<DeliveredCorrection> => {
    let delivery: AgentTurnDelivery

    try {
      delivery = await agent.sendTurn(correction.body, {
        timeoutMs: options.sendTurnTimeoutMs,
      })
    } catch (error) {
      return {
        correctionId: correction.id,
        sequence: correction.sequence,
        outcome: 'failed',
        acknowledgedByAgent: false,
        latencyMs: null,
        failureReason: describeFailure(error),
      }
    }

    if (!delivery.acknowledged) {
      // The write succeeded and nothing confirmed receipt. Saying "delivered" here would be the
      // one lie FR-049 forbids, so it is reported as a failure with a reason that says why.
      return {
        correctionId: correction.id,
        sequence: correction.sequence,
        outcome: 'failed',
        acknowledgedByAgent: false,
        latencyMs: delivery.latencyMs,
        failureReason: UNCONFIRMED_DELIVERY_REASON,
      }
    }

    return {
      correctionId: correction.id,
      sequence: correction.sequence,
      outcome: 'delivered',
      acknowledgedByAgent: true,
      latencyMs: delivery.latencyMs,
    }
  }

  return {
    cycle: async (): Promise<CorrectionCycleResult> => {
      const collected = inSequenceOrder(await transport.pullPendingCorrections())
      const delivered: DeliveredCorrection[] = []

      for (const correction of collected) {
        // Serial, deliberately. `Promise.all` here would deliver the batch in whatever order the
        // agent's input handling happened to produce, and submission order is a requirement.
        const result = await deliverOne(correction)

        await transport.acknowledgeCorrection({
          correctionId: result.correctionId,
          outcome: result.outcome,
          failureReason: result.failureReason,
        })
        delivered.push(result)

        if (result.outcome !== 'delivered') {
          // Stop the batch. Delivering correction 3 after correction 2 failed would put guidance
          // into the conversation out of the order the user wrote it in.
          return { collected: collected.length, delivered, haltedEarly: true }
        }
      }

      return { collected: collected.length, delivered, haltedEarly: false }
    },
  }
}
