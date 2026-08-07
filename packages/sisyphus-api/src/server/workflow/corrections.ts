import { and, eq, isNull } from 'drizzle-orm'

import type { SisyphusDatabase } from '../../db'
import { corrections, workflowEvents } from '../../db'
import type { AcknowledgeCorrectionInput, CorrectWorkflowInput } from '../../schemas'
import { acknowledgeCorrectionInput, correctWorkflowInput, workflowIdInput } from '../../schemas'
import type { MachineContext } from '../machine'
import { machineProcedure, scopedProcedure } from '../procedures'
import type { ResolvedScope } from '../scope'
import { requireWorkflowInScope } from '../scope'

import { inSequenceOrder } from './supersession'
import type { AlreadyFinishedResponse } from './transition'
import {
  describeAlreadyFinished,
  firstRow,
  isAlreadyFinishedFor,
  nextCorrectionSequence,
  runWorkflowTransition,
} from './transition'

/**
 * **Corrections: exactly once, in submission order, and never silently dropped (T093, FR-049).**
 *
 * A correction is an additional user turn delivered into the *live* conversation — the whole point
 * of R1's NDJSON-on-stdin decision is that this costs a line on a pipe rather than a restart. This
 * module owns the queue half; `apps/sisyphus-executor/src/supervision/corrections.ts` owns delivery.
 *
 * ## The three guarantees, and what each one actually rests on
 *
 * **Submission order.** `sequence` is allocated under the workflow row lock (`./transition.ts`), so
 * two people correcting the same run at the same moment get 1 and 2 rather than both getting 1 and
 * one of them losing on the unique index. Delivery reads in `sequence` order and the executor never
 * has two deliveries in flight, so submission order *is* delivery order.
 *
 * **Exactly once.** {@link pullPendingCorrections} returns only rows still `pending`, and
 * {@link acknowledgeCorrection} moves a row out of `pending` with a conditional update that matches
 * on `delivery_outcome = 'pending'`. A row therefore leaves the queue at most once, no matter how
 * many times a retrying executor acknowledges it (FR-047), and a delivered correction can never be
 * returned by a later pull.
 *
 * The honest residual: an instance that delivers a turn and is destroyed before its acknowledgement
 * lands leaves the row `pending`, and the correction is delivered again on the restored instance.
 * That is at-least-once across an instance loss, and it is the deliberate direction — FR-049 forbids
 * a correction being silently dropped, and says nothing against one arriving twice. A duplicate turn
 * is visible in the conversation and harmless; a dropped one is invisible and is the failure the
 * requirement is about. Making it the other way round would mean acknowledging before delivering,
 * which converts every instance loss into a silent drop.
 *
 * **Never silently dropped.** A delivery that fails is acknowledged as `failed` with the reason,
 * which the panel renders next to the correction the user wrote. The executor's `sendTurn` returns
 * `AgentTurnDelivery { acknowledged, latencyMs }` rather than `void` precisely so that "written to
 * the pipe but never echoed back" is reportable as its own outcome instead of being rounded up to
 * success.
 *
 * ## Terminal runs (FR-081)
 *
 * A correction against a finished run is not an error. It is recorded `rejected` with an explanation
 * and answered with the already-finished response, so the user learns *how* the run ended rather
 * than that their text was invalid. See `./transition.ts` → {@link describeAlreadyFinished}.
 */

/** What the panel gets back when a correction was queued. */
export interface CorrectionQueued {
  readonly applied: true
  readonly alreadyFinished: false
  readonly workflowId: string
  readonly correctionId: string
  readonly sequence: number
  readonly body: string
}

/** Queued, or refused with an explanation because the run had already finished (FR-081). */
export type CorrectionResult = CorrectionQueued | AlreadyFinishedResponse

/** Everything {@link submitCorrection} needs. */
export interface CorrectionRequest {
  readonly db: SisyphusDatabase
  readonly scope: ResolvedScope
  /** Who wrote it. Recorded on the row, so guidance given to an agent is attributable. */
  readonly userId: string
  readonly input: CorrectWorkflowInput
}

/**
 * Queue a mid-run correction (FR-015, FR-049, FR-081).
 *
 * The scope check runs before the transaction, so a run the caller may not see is reported absent
 * with the same `NOT_FOUND` a nonexistent id gets and no constraint violation can leak what the
 * check withheld (FR-190).
 *
 * `workflow_state_at_submission` records what the run was doing when the text was written, which is
 * what makes a later rejection explicable: "you wrote this while it was running, and it finished
 * before the instance collected it" is a different story from "you wrote this to a finished run".
 *
 * @param request - See {@link CorrectionRequest}.
 */
export const submitCorrection = async (request: CorrectionRequest): Promise<CorrectionResult> => {
  const { db, scope, userId, input } = request

  await requireWorkflowInScope({ db, scope, workflowId: input.workflowId })

  return runWorkflowTransition({
    db,
    workflowId: input.workflowId,
    apply: async ({ writer, locked }) => {
      const sequence = await nextCorrectionSequence(writer, input.workflowId)

      if (isAlreadyFinishedFor(locked.state, 'correction')) {
        const refusal = describeAlreadyFinished(locked, 'correction')

        await writer.insert(corrections).values({
          workflowId: input.workflowId,
          authorUserId: userId,
          body: input.body,
          workflowStateAtSubmission: locked.state,
          sequence,
          deliveryOutcome: 'rejected',
          failureReason: refusal.explanation,
        })

        return refusal
      }

      const inserted = await writer
        .insert(corrections)
        .values({
          workflowId: input.workflowId,
          authorUserId: userId,
          body: input.body,
          workflowStateAtSubmission: locked.state,
          sequence,
          deliveryOutcome: 'pending',
        })
        .returning({ id: corrections.id })

      const correctionId = firstRow(inserted)?.id

      if (correctionId === undefined) {
        throw new Error('Queueing a correction returned no row.')
      }

      return {
        applied: true,
        alreadyFinished: false,
        workflowId: input.workflowId,
        correctionId,
        sequence,
        body: input.body,
      }
    },
  })
}

/** One correction as the executor sees it. */
export interface PendingCorrection {
  readonly id: string
  readonly sequence: number
  readonly body: string
  readonly submittedAt: Date
}

/**
 * Corrections awaiting delivery for the credential's workflow, in `sequence` order (FR-049).
 *
 * Only `pending` rows. A `delivered`, `failed` or `rejected` row is finished with — returning one
 * would be the duplicate-delivery bug the exactly-once guarantee is about, and it is closed here
 * rather than in the executor because a queue that hands out delivered work is a queue whose
 * consumers all have to remember not to trust it.
 *
 * @param ctx - The machine-procedure context.
 */
export const pullPendingCorrections = async (
  ctx: MachineContext,
): Promise<readonly PendingCorrection[]> => {
  const rows = await ctx.db
    .select({
      id: corrections.id,
      sequence: corrections.sequence,
      body: corrections.body,
      submittedAt: corrections.createdAt,
    })
    .from(corrections)
    .where(
      and(
        eq(corrections.workflowId, ctx.workflowId),
        eq(corrections.deliveryOutcome, 'pending'),
        isNull(corrections.deliveredAt),
      ),
    )

  return inSequenceOrder(rows)
}

/** What an acknowledgement did. */
export interface CorrectionAcknowledgement {
  readonly correctionId: string
  /** False when the row had already left `pending` — a retry, not an error (FR-047). */
  readonly recorded: boolean
  readonly outcome: AcknowledgeCorrectionInput['outcome']
}

/**
 * Record the outcome of one delivery (FR-049).
 *
 * The `where` includes `delivery_outcome = 'pending'`, and that clause is the exactly-once
 * mechanism: the row leaves the queue on the first acknowledgement and every later one matches
 * nothing. A `failed` outcome carries the reason and stays visible to the panel, because the
 * requirement is not "deliver every correction" — it is that a correction which cannot be delivered
 * is **seen** rather than dropped.
 *
 * A `corrected` timeline entry is written only on a delivered correction, so the run's narrative
 * says what actually reached the agent (FR-064).
 *
 * @param ctx - The machine-procedure context.
 * @param input - The correction, the outcome, and a reason when it failed.
 */
export const acknowledgeCorrection = async (
  ctx: MachineContext,
  input: AcknowledgeCorrectionInput,
): Promise<CorrectionAcknowledgement> =>
  ctx.db.transaction(async (writer) => {
    const claimed = await writer
      .update(corrections)
      .set({
        deliveryOutcome: input.outcome,
        deliveredAt: input.outcome === 'delivered' ? new Date() : null,
        failureReason: input.failureReason ?? null,
      })
      .where(
        and(
          eq(corrections.id, input.correctionId),
          // The credential's workflow, never one named in the payload — there is no field for one.
          eq(corrections.workflowId, ctx.workflowId),
          eq(corrections.deliveryOutcome, 'pending'),
        ),
      )
      .returning({ id: corrections.id, sequence: corrections.sequence })

    const row = firstRow(claimed)

    if (row === undefined) {
      return { correctionId: input.correctionId, recorded: false, outcome: input.outcome }
    }

    if (input.outcome === 'delivered') {
      await writer.insert(workflowEvents).values({
        workflowId: ctx.workflowId,
        event: 'corrected',
        actorType: 'executor',
        detail: { correctionId: row.id, sequence: row.sequence },
      })
    }

    return { correctionId: input.correctionId, recorded: true, outcome: input.outcome }
  })

/** One correction as the panel renders it, including a failed delivery. */
export interface CorrectionRecord {
  readonly id: string
  readonly sequence: number
  readonly body: string
  readonly authorUserId: string
  readonly deliveryOutcome: 'pending' | 'delivered' | 'failed' | 'rejected'
  readonly deliveredAt: Date | null
  readonly failureReason: string | null
  readonly submittedAt: Date
}

/**
 * Every correction on a run, oldest first (FR-015, FR-190).
 *
 * Scoped, because the bodies are user-written text about the work and a caller who cannot see the
 * run must not be able to read them — or to learn the run exists by asking.
 *
 * Failures are returned rather than filtered. A panel that showed only delivered corrections would
 * be the silent drop with extra steps.
 */
export const readCorrectionsInScope = async (options: {
  readonly db: SisyphusDatabase
  readonly scope: ResolvedScope
  readonly workflowId: string
}): Promise<readonly CorrectionRecord[]> => {
  await requireWorkflowInScope(options)

  const rows = await options.db
    .select({
      id: corrections.id,
      sequence: corrections.sequence,
      body: corrections.body,
      authorUserId: corrections.authorUserId,
      deliveryOutcome: corrections.deliveryOutcome,
      deliveredAt: corrections.deliveredAt,
      failureReason: corrections.failureReason,
      submittedAt: corrections.createdAt,
    })
    .from(corrections)
    .where(eq(corrections.workflowId, options.workflowId))

  return inSequenceOrder(rows)
}

/** `workflow.correct` — ready to mount (FR-015, FR-049, FR-081). */
export const correctProcedure = scopedProcedure
  .input(correctWorkflowInput)
  .mutation(
    async ({ ctx, input }): Promise<CorrectionResult> =>
      submitCorrection({ db: ctx.db, scope: ctx.scope, userId: ctx.user.id, input }),
  )

/** `workflow.corrections` — ready to mount. The panel's read, including failed deliveries. */
export const correctionsProcedure = scopedProcedure
  .input(workflowIdInput)
  .query(
    async ({ ctx, input }): Promise<readonly CorrectionRecord[]> =>
      readCorrectionsInScope({ db: ctx.db, scope: ctx.scope, workflowId: input.workflowId }),
  )

/**
 * `machine.pullPendingCorrections` — mounted on the machine surface (FR-049).
 *
 * A **mutation**, not a query, even though it reads: every procedure on this surface is a mutation
 * so that none of it can be served over a cacheable GET. A poll answered from an intermediary cache
 * would hand the instance a stale command set, and SC-003's ten seconds would be spent waiting on a
 * pause that had already been collected by nobody.
 */
export const pullPendingCorrectionsProcedure = machineProcedure.mutation(
  async ({ ctx }): Promise<readonly PendingCorrection[]> => pullPendingCorrections(ctx),
)

/** `machine.acknowledgeCorrection` — ready to mount (FR-049). */
export const acknowledgeCorrectionProcedure = machineProcedure
  .input(acknowledgeCorrectionInput)
  .mutation(
    async ({ ctx, input }): Promise<CorrectionAcknowledgement> => acknowledgeCorrection(ctx, input),
  )
