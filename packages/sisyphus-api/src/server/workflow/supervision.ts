import { and, eq, inArray, isNull } from 'drizzle-orm'

import type { SisyphusDatabase } from '../../db'
import { supervisionCommands, workflowEvents, workflows } from '../../db'
import type { WorkflowState } from '../../enums'
import type { AcknowledgeCommandInput } from '../../schemas'
import { acknowledgeCommandInput, workflowIdInput } from '../../schemas'
import type { MachineContext } from '../machine'
import { machineProcedure, scopedProcedure } from '../procedures'
import type { ResolvedScope } from '../scope'
import { requireWorkflowInScope } from '../scope'

import type { SupersessionOutcome, SupervisionCommandName } from './supersession'
import { inSequenceOrder, resolveSupersession } from './supersession'
import type { AlreadyFinishedResponse, LockedWorkflowState, TransitionWriter } from './transition'
import {
  describeAlreadyFinished,
  firstRow,
  isAlreadyFinishedFor,
  nextCommandSequence,
  runWorkflowTransition,
  workflowGoneError,
} from './transition'

/**
 * **The path that makes the pause button work (T089, T096, FR-015, FR-049, FR-081, SC-003).**
 *
 * Without this module the panel's pause mutation writes a row nothing on the instance ever reads,
 * `suspend()` in the executor is fully specified and never invoked, and SC-003's ten-second pause is
 * unreachable — not slow, unreachable, because nothing closes the loop at all.
 *
 * The loop has four parts and all four are here:
 *
 * 1. {@link requestSupervisionCommand} — the panel writes a queue row under the workflow row lock.
 * 2. {@link pullPendingSupervisionCommands} — the executor collects, in `sequence` order.
 * 3. the executor applies (`apps/sisyphus-executor/src/supervision/poll.ts`).
 * 4. {@link acknowledgeSupervisionCommand} — the executor reports back, and **only then** does the
 *    workflow row say `paused`.
 *
 * ## Nothing here reports a pause the instance has not performed
 *
 * Step 1 does not touch `workflows.state`. That is the single most important negative fact in this
 * file: a pause that moved the workflow to `paused` on request would make the panel say "paused"
 * while the agent was still mid-turn, still spending, and still writing to the working tree. The
 * state moves in step 4, from the acknowledgement, which the executor sends after its snapshot is
 * registered (FR-049). Until then the panel has a pending command row and says "pause requested".
 *
 * ## Push versus poll
 *
 * Nothing is pushed to the instance. A run on a reclaimable instance cannot be relied on to be
 * listening, and an instance that has to accept an inbound connection is an instance with an ingress
 * path (FR-035). So the queue is a table and the executor polls it, which also means a command
 * survives the instance being replaced.
 *
 * ## The `superseded` outcome
 *
 * See `./supersession.ts`. A `pause` overtaken by a `stop` before collection is marked `superseded`
 * **in the same transaction that writes the stop**, and comes back from the pull already carrying
 * that outcome — the executor acknowledges it without applying it, rather than never seeing it and
 * leaving a row pending forever.
 */

/** What the panel gets back when a supervision command was actually queued. */
export interface SupervisionCommandQueued {
  readonly applied: true
  readonly alreadyFinished: false
  readonly workflowId: string
  readonly commandId: string
  readonly command: SupervisionCommandName
  readonly sequence: number
  /**
   * `pending` normally; `superseded` when the request was overtaken by an uncollected `stop` before
   * it was written. Recorded rather than refused — see `./supersession.ts`, rule 3.
   */
  readonly outcome: 'pending' | 'superseded'
  /** Ids of previously-queued commands this one replaced. */
  readonly supersededCommandIds: readonly string[]
  /** Present only when this request itself was overtaken. */
  readonly supersededReason: string | null
}

/** Queued, or refused with an explanation because the run had already finished (FR-081). */
export type SupervisionCommandResult = SupervisionCommandQueued | AlreadyFinishedResponse

/** Everything {@link requestSupervisionCommand} needs. */
export interface SupervisionCommandRequest {
  readonly db: SisyphusDatabase
  readonly scope: ResolvedScope
  /** Who pressed the button. Recorded on the row, so a supervision action is attributable. */
  readonly userId: string
  readonly workflowId: string
  readonly command: SupervisionCommandName
}

/** Commands the executor has not yet acknowledged, in `sequence` order. */
const readUncollected = async (
  writer: TransitionWriter,
  workflowId: string,
): Promise<readonly { id: string; command: SupervisionCommandName; sequence: number }[]> =>
  inSequenceOrder(
    await writer
      .select({
        id: supervisionCommands.id,
        command: supervisionCommands.command,
        sequence: supervisionCommands.sequence,
      })
      .from(supervisionCommands)
      .where(
        and(
          eq(supervisionCommands.workflowId, workflowId),
          eq(supervisionCommands.deliveryOutcome, 'pending'),
          isNull(supervisionCommands.acknowledgedAt),
        ),
      ),
  )

/** Mark the rows an incoming command replaced, with the reason on each. */
const applySupersession = async (
  writer: TransitionWriter,
  outcome: SupersessionOutcome,
): Promise<void> => {
  if (outcome.supersededIds.length === 0) {
    return
  }

  await writer
    .update(supervisionCommands)
    .set({ deliveryOutcome: 'superseded', failureReason: outcome.reason })
    .where(inArray(supervisionCommands.id, [...outcome.supersededIds]))
}

/**
 * **The already-finished path (T096, FR-081).**
 *
 * FR-081 asks for two things at once — an explicit already-finished *response*, and the request
 * *recorded as requested-but-not-applied*. A thrown error gives the first and loses the second, and
 * a silent no-op gives neither. So the row is written with `rejected` and an acknowledged timestamp,
 * which is what makes it inert to the executor's pull, and the response says what happened.
 */
const recordRefusedCommand = async (
  writer: TransitionWriter,
  options: {
    readonly locked: LockedWorkflowState
    readonly userId: string
    readonly command: SupervisionCommandName
    readonly refusal: AlreadyFinishedResponse
  },
): Promise<void> => {
  const sequence = await nextCommandSequence(writer, options.locked.id)

  await writer.insert(supervisionCommands).values({
    workflowId: options.locked.id,
    command: options.command,
    requestedByUserId: options.userId,
    sequence,
    deliveryOutcome: 'rejected',
    // Timestamped as acknowledged so no executor ever collects it: it was answered here.
    acknowledgedAt: new Date(),
    failureReason: options.refusal.explanation,
  })
}

/**
 * Queue a `pause`, `resume` or `stop` (FR-015, FR-049, FR-081).
 *
 * The scope check runs **before** the transaction and is not optional: a workflow the caller may not
 * see is reported absent with the same `NOT_FOUND` a nonexistent id gets, so this mutation cannot be
 * used to discover that a run exists (FR-190). Nothing below is reached in that case, so no
 * constraint violation can leak what the check withheld.
 *
 * @param request - See {@link SupervisionCommandRequest}.
 */
export const requestSupervisionCommand = async (
  request: SupervisionCommandRequest,
): Promise<SupervisionCommandResult> => {
  const { db, scope, userId, workflowId, command } = request

  await requireWorkflowInScope({ db, scope, workflowId })

  return runWorkflowTransition({
    db,
    workflowId,
    apply: async ({ writer, locked }) => {
      if (isAlreadyFinishedFor(locked.state, command)) {
        const refusal = describeAlreadyFinished(locked, command)
        await recordRefusedCommand(writer, { locked, userId, command, refusal })

        return refusal
      }

      const uncollected = await readUncollected(writer, workflowId)
      const supersession = resolveSupersession(uncollected, command)
      await applySupersession(writer, supersession)

      const sequence = await nextCommandSequence(writer, workflowId)
      const outcome = supersession.incomingIsSuperseded ? 'superseded' : 'pending'

      const inserted = await writer
        .insert(supervisionCommands)
        .values({
          workflowId,
          command,
          requestedByUserId: userId,
          sequence,
          deliveryOutcome: outcome,
          failureReason: supersession.incomingIsSuperseded ? supersession.reason : null,
        })
        .returning({ id: supervisionCommands.id })

      const commandId = firstRow(inserted)?.id

      if (commandId === undefined) {
        throw new Error('Queueing a supervision command returned no row.')
      }

      return {
        applied: true,
        alreadyFinished: false,
        workflowId,
        commandId,
        command,
        sequence,
        outcome,
        supersededCommandIds: supersession.supersededIds,
        supersededReason: supersession.incomingIsSuperseded ? supersession.reason : null,
      }
    },
  })
}

/** One row as the executor sees it. */
export interface PendingSupervisionCommand {
  readonly id: string
  readonly command: SupervisionCommandName
  readonly sequence: number
  /**
   * `pending` — apply it. `superseded` — acknowledge it and do **not** apply it. Both are returned,
   * because a superseded row the executor never sees is a row that stays uncollected forever.
   */
  readonly deliveryOutcome: 'pending' | 'superseded'
  readonly failureReason: string | null
  readonly requestedAt: Date
}

/**
 * Everything uncollected for the credential's workflow, in `sequence` order (FR-049, SC-003).
 *
 * Scoped to `ctx.workflowId` and to nothing else — there is no field in the input for a workflow id,
 * deliberately, so there is no cross-workflow read to close here.
 *
 * The `where` is `acknowledged_at is null`, not `delivery_outcome = 'pending'`, and the difference is
 * the whole supersession contract: a superseded row is no longer pending but is still uncollected,
 * and the executor has to see it in order to acknowledge it.
 *
 * @param ctx - The machine-procedure context.
 */
export const pullPendingSupervisionCommands = async (
  ctx: MachineContext,
): Promise<readonly PendingSupervisionCommand[]> => {
  const rows = await ctx.db
    .select({
      id: supervisionCommands.id,
      command: supervisionCommands.command,
      sequence: supervisionCommands.sequence,
      deliveryOutcome: supervisionCommands.deliveryOutcome,
      failureReason: supervisionCommands.failureReason,
      requestedAt: supervisionCommands.createdAt,
    })
    .from(supervisionCommands)
    .where(
      and(
        eq(supervisionCommands.workflowId, ctx.workflowId),
        isNull(supervisionCommands.acknowledgedAt),
        inArray(supervisionCommands.deliveryOutcome, ['pending', 'superseded']),
      ),
    )

  return inSequenceOrder(rows).map((row) => ({
    ...row,
    // `rejected` rows are written already acknowledged, so the two remaining outcomes are the only
    // ones reachable here. Narrowing rather than casting keeps that a checked claim.
    deliveryOutcome: row.deliveryOutcome === 'superseded' ? 'superseded' : 'pending',
  }))
}

/** What an acknowledgement did. */
export interface CommandAcknowledgement {
  readonly commandId: string
  /** False when the row had already been acknowledged — a retry, not an error (FR-047). */
  readonly recorded: boolean
  /** The state now recorded on the run, after any transition the acknowledgement caused. */
  readonly workflowState: WorkflowState
}

/**
 * The state an acknowledged command moves the workflow to, or `null` for none.
 *
 * **This is where "paused" becomes true.** Pure and separate so the rule is testable without a
 * database, and so it is obvious that only an `acknowledged` outcome moves anything: a `superseded`
 * or `rejected` acknowledgement records that the executor saw the row and did nothing with it.
 *
 * `stop` moves nothing. The run's terminal outcome is `cancelled` and it is written by
 * `reportTerminal` with the consumption figures attached (FR-056, FR-064); setting it here as well
 * would give one run two authors for its one outcome.
 */
export const stateAfterAcknowledgement = (options: {
  readonly command: SupervisionCommandName
  readonly outcome: AcknowledgeCommandInput['outcome']
}): 'paused' | 'running' | null => {
  if (options.outcome !== 'acknowledged') {
    return null
  }

  if (options.command === 'pause') {
    return 'paused'
  }

  return options.command === 'resume' ? 'running' : null
}

const TIMELINE_EVENT = {
  pause: 'paused',
  resume: 'resumed',
} as const

/**
 * Record what the executor did with a command (FR-049, SC-003).
 *
 * Idempotent on `acknowledged_at is null`: the executor buffers and retries this call whenever the
 * API is unreachable (FR-047) and cannot tell a lost response from a failed write, so a second
 * acknowledgement of the same row must be an ordinary answer rather than an error. The second call
 * returns `recorded: false` and changes nothing — which also means the `paused` timeline entry is
 * written once, not once per retry.
 *
 * @param ctx - The machine-procedure context.
 * @param input - The command, the outcome, and a reason when it failed.
 */
export const acknowledgeSupervisionCommand = async (
  ctx: MachineContext,
  input: AcknowledgeCommandInput,
): Promise<CommandAcknowledgement> =>
  ctx.db.transaction(async (writer) => {
    const claimed = await writer
      .update(supervisionCommands)
      .set({
        deliveryOutcome: input.outcome,
        acknowledgedAt: new Date(),
        failureReason: input.failureReason ?? null,
      })
      .where(
        and(
          eq(supervisionCommands.id, input.commandId),
          // The credential's workflow, never one named in the payload — there is no field for one.
          eq(supervisionCommands.workflowId, ctx.workflowId),
          isNull(supervisionCommands.acknowledgedAt),
        ),
      )
      .returning({ command: supervisionCommands.command })

    const row = firstRow(claimed)
    const current = firstRow(
      await writer
        .select({ state: workflows.state })
        .from(workflows)
        .where(eq(workflows.id, ctx.workflowId))
        .limit(1),
    )

    if (current === undefined) {
      throw workflowGoneError()
    }

    if (row === undefined) {
      return { commandId: input.commandId, recorded: false, workflowState: current.state }
    }

    const nextState = stateAfterAcknowledgement({ command: row.command, outcome: input.outcome })

    if (nextState === null) {
      return { commandId: input.commandId, recorded: true, workflowState: current.state }
    }

    await writer.update(workflows).set({ state: nextState }).where(eq(workflows.id, ctx.workflowId))

    await writer.insert(workflowEvents).values({
      workflowId: ctx.workflowId,
      event: TIMELINE_EVENT[row.command === 'pause' ? 'pause' : 'resume'],
      actorType: 'executor',
      detail: { commandId: input.commandId },
    })

    return { commandId: input.commandId, recorded: true, workflowState: nextState }
  })

/** `workflow.pause` — ready to mount (FR-015, FR-049, FR-081, SC-003). */
export const pauseProcedure = scopedProcedure.input(workflowIdInput).mutation(
  async ({ ctx, input }): Promise<SupervisionCommandResult> =>
    requestSupervisionCommand({
      db: ctx.db,
      scope: ctx.scope,
      userId: ctx.user.id,
      workflowId: input.workflowId,
      command: 'pause',
    }),
)

/** `workflow.resume` — ready to mount. Permitted against a parked run; see `./transition.ts`. */
export const resumeProcedure = scopedProcedure.input(workflowIdInput).mutation(
  async ({ ctx, input }): Promise<SupervisionCommandResult> =>
    requestSupervisionCommand({
      db: ctx.db,
      scope: ctx.scope,
      userId: ctx.user.id,
      workflowId: input.workflowId,
      command: 'resume',
    }),
)

/** `workflow.stop` — ready to mount. Supersedes any uncollected pause or resume. */
export const stopProcedure = scopedProcedure.input(workflowIdInput).mutation(
  async ({ ctx, input }): Promise<SupervisionCommandResult> =>
    requestSupervisionCommand({
      db: ctx.db,
      scope: ctx.scope,
      userId: ctx.user.id,
      workflowId: input.workflowId,
      command: 'stop',
    }),
)

/**
 * `machine.pullPendingCommands` — mounted on the machine surface (FR-049, SC-003).
 *
 * A **mutation**, not a query, even though it reads: every procedure on this surface is a mutation
 * so that none of it can be served over a cacheable GET. A poll answered from an intermediary cache
 * would hand the instance a stale command set, and SC-003's ten seconds would be spent waiting on a
 * pause that had already been collected by nobody.
 */
export const pullPendingCommandsProcedure = machineProcedure.mutation(
  async ({ ctx }): Promise<readonly PendingSupervisionCommand[]> =>
    pullPendingSupervisionCommands(ctx),
)

/** `machine.acknowledgeCommand` — ready to mount. This is what makes "paused" true (SC-003). */
export const acknowledgeCommandProcedure = machineProcedure
  .input(acknowledgeCommandInput)
  .mutation(
    async ({ ctx, input }): Promise<CommandAcknowledgement> =>
      acknowledgeSupervisionCommand(ctx, input),
  )
