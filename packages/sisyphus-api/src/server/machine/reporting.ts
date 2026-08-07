import { TRPCError } from '@trpc/server'
import { and, eq, isNull, max, sql } from 'drizzle-orm'

import type { BootstrapPhase, SisyphusDatabase, Workflow } from '../../db'
import { bootstrapPhases, computeLeases, workflowEvents, workflows } from '../../db'
import type { TerminalOutcome, WorkflowState } from '../../enums'
import type { HeartbeatInput, ReportBootstrapPhaseInput, ReportTerminalInput } from '../../schemas'
import { emitWorkflowEvent, notificationEventForOutcome } from '../notify'

import type { MachineContext } from './guard'
import { firstRow, isTerminalState, loadMachineWorkflow, resolveOptionalEntry } from './guard'

/**
 * What an executor reports about its own progress: liveness, bootstrap, and the end.
 *
 * Every write here is scoped to `ctx.workflowId`, which is not a check performed but a shape: the
 * `where` clauses below are written against the credential's workflow id and there is no code path
 * that takes one from the payload (see `./guard.ts` for the one vector that exists, `entryId`, and
 * how it is closed).
 *
 * ## Retry safety, everywhere
 *
 * FR-047 has the executor buffering and retrying with backoff whenever this surface is
 * unreachable, and it cannot distinguish "the write failed" from "the response was lost". Only
 * `appendLogSegment` is *specified* idempotent, but the same pressure applies to all of these, so
 * each is written to survive being called twice:
 *
 * - consumption figures move under `greatest(…)`, so a retried older heartbeat cannot walk turns
 *   or spend backwards;
 * - a bootstrap phase is keyed on `(workflow, phase, entry)` and updated rather than re-inserted;
 * - `reportTerminal` keeps the **first** outcome and reports the second as not recorded, which is
 *   what makes FR-064's "exactly one outcome in force" hold against a retry as well as against a
 *   race.
 *
 * ## The one thing here that leaves the database
 *
 * `reportTerminal` announces the outcome it wrote (FR-136). Four of FR-136's six workflow events —
 * `workflow_succeeded`, `workflow_capped`, `workflow_cancelled` and `workflow_needs_attention` —
 * are reachable only through this function, so without the emission below they would never fire at
 * all. It goes through the injected port in `../notify/`, **after** the transaction has committed
 * and outside it, and it cannot fail the report: see {@link reportTerminal} for both arguments.
 */

/** Anything that can run these statements — the pooled handle or a transaction on it. */
export type ReportWriter = Pick<SisyphusDatabase, 'select' | 'insert' | 'update'>

/** What `heartbeat` answers with. */
export interface HeartbeatAcknowledgement {
  readonly acknowledgedAt: Date
  /** The state now recorded on the run. Not necessarily the one reported — see below. */
  readonly state: WorkflowState
  /**
   * `false` when the run had already reached a terminal state and nothing was written. A late
   * heartbeat from an instance that has not yet been destroyed is ordinary, not an error: making
   * it one would push the executor into a retry loop over a run that has finished.
   */
  readonly accepted: boolean
}

/** Refusal for a heartbeat claiming a state only `reportTerminal` may set. */
export const terminalHeartbeatError = (): TRPCError =>
  new TRPCError({
    code: 'BAD_REQUEST',
    message: 'A terminal state must be reported through reportTerminal.',
  })

/**
 * Liveness plus consumption (FR-048).
 *
 * The reconciler reads `compute_leases.last_heartbeat_at` to decide whether a run is alive, so
 * this touches the lease as well as the workflow — a heartbeat that updated only the workflow row
 * would leave the sweep believing the instance had gone.
 *
 * Consumption is written with `greatest`, never assigned: heartbeats are retried and can arrive
 * out of order, and a run whose recorded spend went *down* would make the FR-055 cap unenforceable
 * from the platform's side.
 */
export const heartbeat = async (
  ctx: MachineContext,
  input: HeartbeatInput,
): Promise<HeartbeatAcknowledgement> => {
  if (isTerminalState(input.state)) {
    throw terminalHeartbeatError()
  }

  const workflow = await loadMachineWorkflow(ctx)
  const acknowledgedAt = new Date()

  if (isTerminalState(workflow.state)) {
    return { acknowledgedAt, state: workflow.state, accepted: false }
  }

  await ctx.db
    .update(workflows)
    .set({
      state: input.state,
      turnsUsed: sql`greatest(${workflows.turnsUsed}, ${input.turnsUsed})`,
      spendUsed: sql`greatest(${workflows.spendUsed}, ${input.spendUsed}::numeric)`,
    })
    .where(eq(workflows.id, ctx.workflowId))

  await ctx.db
    .update(computeLeases)
    .set({ lastHeartbeatAt: acknowledgedAt })
    .where(and(eq(computeLeases.workflowId, ctx.workflowId), isNull(computeLeases.releasedAt)))

  return { acknowledgedAt, state: input.state, accepted: true }
}

/** The audit path recorded against a cross-workflow bootstrap report. */
export const REPORT_BOOTSTRAP_PHASE_PATH = 'machine.reportBootstrapPhase'

/**
 * Record the outcome of one bootstrap step (FR-145, FR-146).
 *
 * Each phase has its own timeout, so a hung bootstrap fails **naming the phase** rather than
 * emitting a generic timeout — which is the difference between an opaque multi-minute
 * "provisioning" state and one a human can act on.
 *
 * `sequence` is allocated by counting what is already recorded for the run, inside a transaction
 * that locks the workflow row first. Locking is what makes two concurrent per-entry checkouts
 * queue rather than both computing the same next number and one of them losing on
 * `bootstrap_phases_sequence_key`. A repeat report for the same `(phase, entry)` updates the
 * existing row, so a retry refines the record instead of appending a second version of it.
 */
export const reportBootstrapPhase = async (
  ctx: MachineContext,
  input: ReportBootstrapPhaseInput,
): Promise<BootstrapPhase> => {
  const entryId = await resolveOptionalEntry(ctx, input.entryId, REPORT_BOOTSTRAP_PHASE_PATH)

  return ctx.db.transaction(async (tx) => {
    // Serialises phase reports for this run, and nothing else: the lock is on the one workflow
    // row the credential covers.
    await tx
      .select({ id: workflows.id })
      .from(workflows)
      .where(eq(workflows.id, ctx.workflowId))
      .for('update')

    const existing = firstRow(
      await tx
        .select()
        .from(bootstrapPhases)
        .where(
          and(
            eq(bootstrapPhases.workflowId, ctx.workflowId),
            eq(bootstrapPhases.phase, input.phase),
            entryId === null
              ? isNull(bootstrapPhases.entryId)
              : eq(bootstrapPhases.entryId, entryId),
          ),
        )
        .limit(1),
    )

    if (existing !== undefined) {
      const updated = firstRow(
        await tx
          .update(bootstrapPhases)
          .set({ outcome: input.outcome, detail: input.detail ?? null, endedAt: new Date() })
          .where(eq(bootstrapPhases.id, existing.id))
          .returning(),
      )
      if (updated === undefined) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'The bootstrap phase could not be recorded.',
        })
      }
      return updated
    }

    const highest = firstRow(
      await tx
        .select({ value: max(bootstrapPhases.sequence) })
        .from(bootstrapPhases)
        .where(eq(bootstrapPhases.workflowId, ctx.workflowId)),
    )

    const inserted = firstRow(
      await tx
        .insert(bootstrapPhases)
        .values({
          workflowId: ctx.workflowId,
          phase: input.phase,
          entryId,
          sequence: (highest?.value ?? 0) + 1,
          outcome: input.outcome,
          detail: input.detail ?? null,
          endedAt: new Date(),
        })
        .returning(),
    )

    if (inserted === undefined) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'The bootstrap phase could not be recorded.',
      })
    }
    return inserted
  })
}

/**
 * The timeline event each terminal outcome writes (FR-064).
 *
 * Only `parked_resumable` needs translating: it is an outcome the run can be resumed *out of*
 * (FR-151), and the timeline calls that moment `parked`.
 */
const TERMINAL_EVENTS = {
  succeeded: 'succeeded',
  failed: 'failed',
  capped: 'capped',
  cancelled: 'cancelled',
  needs_attention: 'needs_attention',
  parked_resumable: 'parked',
} as const satisfies Record<TerminalOutcome, string>

/** What `reportTerminal` answers with. */
export interface TerminalReport {
  readonly workflow: Workflow
  /**
   * `false` when the run was already terminal and the **first** outcome was kept. FR-064 allows
   * exactly one outcome in force, so a second report is answered rather than applied — and
   * answered successfully, because a retry that failed here would never stop retrying.
   */
  readonly recorded: boolean
}

/**
 * Write the outcome. Split out of {@link reportTerminal} so the transaction has a name and an
 * end, and so it is visually impossible to add a notification inside it.
 */
const recordTerminalOutcome = async (
  ctx: MachineContext,
  input: ReportTerminalInput,
): Promise<TerminalReport> =>
  ctx.db.transaction(async (tx) => {
    const locked = firstRow(
      await tx.select().from(workflows).where(eq(workflows.id, ctx.workflowId)).for('update'),
    )

    if (locked === undefined) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'This workflow no longer exists.' })
    }

    if (isTerminalState(locked.state)) {
      return { workflow: locked, recorded: false }
    }

    const updated = firstRow(
      await tx
        .update(workflows)
        .set({
          state: input.outcome,
          terminalOutcome: input.outcome,
          outcomeReason: input.reason,
          turnsUsed: sql`greatest(${workflows.turnsUsed}, ${input.turnsUsed})`,
          spendUsed: sql`greatest(${workflows.spendUsed}, ${input.spendUsed}::numeric)`,
        })
        .where(eq(workflows.id, ctx.workflowId))
        .returning(),
    )

    if (updated === undefined) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'The terminal outcome could not be recorded.',
      })
    }

    await tx.insert(workflowEvents).values({
      workflowId: ctx.workflowId,
      event: TERMINAL_EVENTS[input.outcome],
      actorType: 'executor',
      detail: {
        reason: input.reason,
        turnsUsed: input.turnsUsed,
        spendUsed: input.spendUsed,
      },
    })

    return { workflow: updated, recorded: true }
  })

/**
 * The last thing an executor says (FR-056, FR-064), and the message it sets off (FR-136).
 *
 * The workflow row is locked before it is read, so two reports racing — the executor's and the
 * reconciler's backstop, say — cannot both see a non-terminal run and both write an outcome. The
 * loser reads the committed state and returns `recorded: false`.
 *
 * ## Why the notification is out here rather than in the transaction
 *
 * Two reasons, and the second is the one that matters.
 *
 * A message about an uncommitted outcome can be a message about an outcome that never happens: the
 * transaction can still roll back after the notifier has been called, and Slack has no undo. So the
 * announcement waits for the commit, and the seam is constructed so it *cannot* be moved inside —
 * `recordTerminalOutcome` owns the transaction and returns before this line is reached.
 *
 * More importantly, a notifier called inside `ctx.db.transaction` is enlisted in it. FR-141 says a
 * delivery failure must not alter the workflow's outcome; a notifier that threw inside the
 * transaction would roll the outcome back *even with the throw swallowed*, because the failure
 * would already have poisoned the surrounding statement. `emitWorkflowEvent` never rejects, but
 * that is the second line of defence, not the first — being outside the transaction is the first.
 *
 * ## Why only when `recorded`
 *
 * FR-047 has the executor retrying this call whenever the surface is unreachable, and it cannot
 * tell a lost response from a failed write. A second report keeps the first outcome and changes
 * nothing, so announcing it again would send a duplicate Slack message for a run that finished
 * once — the burst FR-139 exists to prevent, arriving by the one route coalescing cannot see.
 */
export const reportTerminal = async (
  ctx: MachineContext,
  input: ReportTerminalInput,
): Promise<TerminalReport> => {
  const report = await recordTerminalOutcome(ctx, input)
  // The **committed** outcome, not the requested one. They are the same today, and reading the row
  // is what keeps them the same tomorrow: FR-118's `honestTerminalOutcome` substitutes
  // `needs_attention` for a success that did not land every repository, and an announcement keyed
  // on the request would then tell the owner their run succeeded while the record said otherwise.
  const outcome = report.workflow.terminalOutcome

  if (report.recorded && outcome !== null) {
    // Result deliberately unread. There is nothing this function may do about a failed
    // notification: the outcome is committed, and FR-141 forbids the delivery changing it.
    await emitWorkflowEvent(ctx.dependencies.notifier, {
      workflowId: ctx.workflowId,
      event: notificationEventForOutcome(outcome),
    })
  }

  return report
}
