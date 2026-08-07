import { TRPCError } from '@trpc/server'
import { and, eq } from 'drizzle-orm'

import type { ExternalAction } from '../../db'
import { externalActions } from '../../db'
import type { ReportExternalActionInput } from '../../schemas'
import { reportExternalActionInput } from '../../schemas'
import { machineProcedure } from '../procedures'

import type { MachineContext } from './guard'
import { firstRow } from './guard'

/**
 * `machine.reportExternalAction` — the durable half of exactly-once (T180, FR-076, FR-077).
 *
 * ## The half that was missing
 *
 * `apps/sisyphus-executor/src/delivery/external-action.ts` derives a key from what an action *is*
 * — the run, the kind, and what it acts on — and remembers results against it, so a retry inside
 * one process replays rather than posting a second comment on a customer's ticket. Its own module
 * note concedes the limit: the ledger is a `new Map()`, "the durable half of FR-076 is
 * `external_actions` on the machine surface". There was no procedure for it, so nothing — not even
 * a test — had ever inserted a row into that table, and the guarantee held only for as long as one
 * process lived. An instance reclaimed mid-delivery and replaced comes back with the map empty,
 * and the replacement re-posts.
 *
 * The spec says the unique index is what makes the action exactly-once. This is the procedure that
 * makes that true of the implementation.
 *
 * ## The claim is the point, not the record
 *
 * A log of what happened would not have fixed anything: by the time you can write "comment posted"
 * the comment is posted, and a second process asking afterwards has already asked too late. So this
 * procedure is called **before** the action, and its answer decides whether the caller performs it:
 *
 * 1. Executor reports `{ kind, targetReference, idempotencyKey, result: 'pending', attemptCount }`.
 * 2. The insert races every other attempt for the same key through
 *    `external_actions_idempotency_key`, unique on `(workflow_id, kind, idempotency_key)`. Exactly
 *    one insert wins. The winner gets `claimed: true` and is the process that may act.
 *    Every other caller gets `claimed: false` and the row as it stands.
 * 3. The winner performs the action and reports again with `succeeded` or `failed`.
 *
 * A caller that gets `alreadyPerformed: true` must not act: the action is on record as having
 * landed, whichever process landed it and whenever. That is the cross-process guarantee, and it
 * survives a re-provision because it is a row rather than a map.
 *
 * `claimed: false` with `result: 'pending'` is the genuinely awkward case and it is reported
 * honestly rather than resolved here. It means another attempt holds the claim and has not said how
 * it went — the instance may still be working, or may have died mid-flight. Deciding how long to
 * wait is a policy about instance liveness, which this procedure has no view of; what it owes the
 * caller is the fact.
 *
 * ## What a later report may and may not change
 *
 * The row is claimed once and never re-inserted, so the progression rules are all that is left:
 *
 * - `pending → succeeded`, `pending → failed`, `failed → succeeded` are recorded. Each is a real
 *   change of what is known.
 * - **`succeeded` is terminal.** A retry reporting `failed` over it does not erase it. FR-047 has
 *   the executor retrying on a lost response, so "the report failed" and "the action failed" arrive
 *   looking identical — and treating the first as the second would license a second comment.
 * - `→ pending` never regresses a settled row.
 * - `attemptCount` moves under `greatest`, the same rule and for the same reason as `heartbeat`'s
 *   consumption figures: reports are retried and can arrive out of order, and a stale one must not
 *   walk the count backwards.
 *
 * ## Scoping
 *
 * `workflow_id` comes from the credential and the payload carries none, so there is nothing to
 * compare and no vector for a cross-workflow write — which is also why the unique index is scoped
 * per run: two runs proposing the same pull request are two actions, and a key that spanned runs
 * would suppress the second one.
 */

/** The unique index that makes the claim a race exactly one caller wins. */
export const EXTERNAL_ACTION_IDEMPOTENCY_INDEX = 'external_actions_idempotency_key'

/** What `reportExternalAction` answers with. */
export interface ExternalActionReport {
  /** The durable row, as it stands after this call. */
  readonly action: ExternalAction
  /**
   * `true` when **this** call inserted the row. The caller that gets it is the one attempt entitled
   * to perform the action; every other caller for this key gets `false`.
   */
  readonly claimed: boolean
  /**
   * `true` when the recorded result is `succeeded`. Nobody may perform the action again, in this
   * process or any other. This is the flag a re-provisioned instance with a cold ledger reads.
   */
  readonly alreadyPerformed: boolean
}

/** Whether a reported result may replace the one already on record. */
export const supersedesExternalActionResult = (
  stored: ExternalAction['result'],
  reported: ExternalAction['result'],
): boolean => {
  // Terminal. A retried failure report after a success is the lost-response case, not a reversal.
  if (stored === 'succeeded') {
    return false
  }
  // Nothing regresses to "not yet known".
  if (reported === 'pending') {
    return false
  }
  return stored !== reported
}

/**
 * Claim, or report the outcome of, one action taken outside the platform.
 *
 * @param ctx - The machine resolver context.
 * @param input - The validated `reportExternalAction` payload.
 * @returns The row, whether this call claimed it, and whether the action has already landed.
 * @throws {TRPCError} `INTERNAL_SERVER_ERROR` only when the row can neither be inserted nor read
 *   back, which means it was deleted between the two statements.
 */
export const reportExternalAction = async (
  ctx: MachineContext,
  input: ReportExternalActionInput,
): Promise<ExternalActionReport> =>
  ctx.db.transaction(async (tx) => {
    const claimed = firstRow(
      await tx
        .insert(externalActions)
        .values({
          workflowId: ctx.workflowId,
          kind: input.kind,
          targetReference: input.targetReference,
          idempotencyKey: input.idempotencyKey,
          result: input.result,
          attemptCount: input.attemptCount,
        })
        .onConflictDoNothing({
          target: [
            externalActions.workflowId,
            externalActions.kind,
            externalActions.idempotencyKey,
          ],
        })
        .returning(),
    )

    if (claimed !== undefined) {
      return { action: claimed, claimed: true, alreadyPerformed: claimed.result === 'succeeded' }
    }

    const identity = and(
      eq(externalActions.workflowId, ctx.workflowId),
      eq(externalActions.kind, input.kind),
      eq(externalActions.idempotencyKey, input.idempotencyKey),
    )

    // The index refused the insert, so an attempt for this key is already on record. It is locked
    // before it is read: {@link supersedesExternalActionResult} is the one statement of the
    // progression rule and it decides in TypeScript, so two concurrent reports must not both be
    // allowed to see `pending` and both decide they may write.
    const locked = firstRow(await tx.select().from(externalActions).where(identity).for('update'))

    if (locked === undefined) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'The external action could not be recorded.',
      })
    }

    const result = supersedesExternalActionResult(locked.result, input.result)
      ? input.result
      : locked.result

    const settled = firstRow(
      await tx
        .update(externalActions)
        .set({
          result,
          // `greatest`, not assignment: reports are retried and can arrive out of order, and a
          // stale one must not walk the count backwards (the `heartbeat` rule).
          attemptCount: Math.max(locked.attemptCount, input.attemptCount),
        })
        .where(identity)
        .returning(),
    )

    if (settled === undefined) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'The external action could not be recorded.',
      })
    }

    return { action: settled, claimed: false, alreadyPerformed: settled.result === 'succeeded' }
  })

/**
 * `machine.reportExternalAction` — ready to mount beside the other machine procedures.
 *
 * Exported rather than assembled in `router.ts`, like `reportIterationProcedure`, so the schema,
 * the resolver and the `machineProcedure` base stay in one place.
 */
export const reportExternalActionProcedure = machineProcedure
  .input(reportExternalActionInput)
  .mutation(
    async ({ ctx, input }): Promise<ExternalActionReport> =>
      reportExternalAction(
        {
          db: ctx.db,
          workflowId: ctx.workflowId,
          credential: ctx.credential,
          dependencies: ctx.dependencies,
        },
        input,
      ),
  )

export type { ExternalAction }
