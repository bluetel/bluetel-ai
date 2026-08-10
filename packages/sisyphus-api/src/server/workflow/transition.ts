import { TRPCError } from '@trpc/server'
import { eq, max } from 'drizzle-orm'

import type { SisyphusDatabase, Workflow } from '../../db'
import { corrections, supervisionCommands, workflows } from '../../db'
import type { TerminalOutcome, WorkflowState } from '../../enums'
import { TERMINAL_WORKFLOW_STATES } from '../../enums'

/**
 * **Row-level serialisation of supervision transitions (T094, FR-049, FR-081).**
 *
 * Every supervision write — pause, resume, stop, correction — is a read-decide-write over the same
 * workflow row: read the state, decide whether the request is admissible, allocate the next
 * `sequence`, write. Run that under `read committed` without a lock and two concurrent requests both
 * read the pre-race state and both decide, which produces two failures that look nothing alike:
 *
 * - **Two commands claim the same `sequence`.** `supervision_commands_sequence_key` is unique on
 *   `(workflow_id, sequence)`, so the loser does not corrupt anything — it raises a constraint
 *   violation the user sees as an opaque database error on a button press. Same for
 *   `corrections_sequence_key`, where the price is worse: submission order *is* delivery order
 *   (FR-049), and a correction that failed to take a number has no place in it.
 * - **A supervision command is accepted against a state that has already changed.** A `stop` and a
 *   `pause` racing both read `running`, so neither supersedes the other, and the executor collects
 *   two live commands with no recorded relationship between them — the exact interleaving
 *   `supersession.ts` exists to prevent.
 *
 * So there is one entry point, {@link runWorkflowTransition}, and it does three things in one
 * transaction: `select … for update` on the workflow row, hand the caller the locked state, and
 * commit. The lock is on the **workflow**, not on the queue tables, because that is the row every
 * supervision decision is a function of — locking the queue rows instead would leave two callers
 * free to disagree about the workflow's state while agreeing about the queue.
 *
 * ## Why `for update` and not `select` + a unique index
 *
 * The index catches a duplicate `sequence` after the fact. It cannot express "do not accept a pause
 * against a workflow another transaction is concurrently stopping", because that is a rule about a
 * *decision*, not about a value. Under `read committed` a locking read that meets a row updated by a
 * transaction that has since committed re-fetches the newest version (EvalPlanQual), so the loser of
 * a race wakes up seeing the winner's write and decides against the state that actually exists. A
 * plain read returns the pre-race state and decides against a fiction.
 *
 * `workflow/transition.test.ts` proves this with two real transactions and `pg_stat_activity`, not
 * with a sequential pair — a sequential test passes just as happily with the lock deleted.
 */

/** Anything that can run these statements — the pooled handle or a transaction derived from it. */
export type TransitionWriter = Pick<SisyphusDatabase, 'select' | 'insert' | 'update'>

/**
 * The first row, honestly typed.
 *
 * `noUncheckedIndexedAccess` is off in this project, so `rows[0]` is typed as present even when the
 * result set is empty — and a `=== undefined` guard against it is narrowed away as unreachable.
 * Going through a function whose *declared* return type admits `undefined` restores the check.
 */
export const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/** The facts about a workflow every supervision decision is a function of. Nothing else is read. */
export interface LockedWorkflowState {
  readonly id: string
  readonly state: WorkflowState
  readonly terminalOutcome: TerminalOutcome | null
  readonly outcomeReason: string | null
  /** When the row was last written. Stands in for "when it finished" on a terminal row. */
  readonly recordedAt: Date
}

/**
 * Take the row lock and read the state under it.
 *
 * **Must be called inside a transaction.** Called on the pooled handle, the lock is taken and
 * released by the same implicit transaction as the select, which makes every decision downstream of
 * it advisory again — the row is free to change between this statement and the write.
 *
 * @param writer - The surrounding transaction.
 * @param workflowId - The run being supervised.
 */
export const lockWorkflowForTransition = async (
  writer: TransitionWriter,
  workflowId: string,
): Promise<LockedWorkflowState | undefined> => {
  const rows = await writer
    .select({
      id: workflows.id,
      state: workflows.state,
      terminalOutcome: workflows.terminalOutcome,
      outcomeReason: workflows.outcomeReason,
      recordedAt: workflows.updatedAt,
    })
    .from(workflows)
    .where(eq(workflows.id, workflowId))
    .for('update')

  return firstRow(rows)
}

/**
 * Run `apply` with the workflow row locked, in one transaction.
 *
 * The callback receives the state **as locked**, so a decision it makes is a decision about the row
 * as it exists at that moment and stays that way until commit. A caller that wants to read the state
 * before opening the transaction has re-derived the race this module exists to close.
 *
 * @param options.db - The pooled handle; the transaction is opened here.
 * @param options.workflowId - The run being supervised.
 * @param options.apply - Runs inside the transaction, against the locked row.
 */
export const runWorkflowTransition = async <TResult>(options: {
  readonly db: SisyphusDatabase
  readonly workflowId: string
  readonly apply: (context: {
    readonly writer: TransitionWriter
    readonly locked: LockedWorkflowState
  }) => Promise<TResult>
}): Promise<TResult> =>
  options.db.transaction(async (writer) => {
    const locked = await lockWorkflowForTransition(writer, options.workflowId)

    if (locked === undefined) {
      // Indistinguishable from an out-of-scope run, and deliberately so: the caller has already
      // been through `requireWorkflowInScope`, and a *different* error for a row that vanished
      // between the two would be an oracle for ids the scope check just withheld (FR-190).
      throw workflowGoneError()
    }

    return options.apply({ writer, locked })
  })

/** A run that disappeared between the scope check and the lock. Worded like every other absence. */
export const workflowGoneError = (): TRPCError =>
  new TRPCError({ code: 'NOT_FOUND', message: 'Workflow not found.' })

/** Whether a state is one no further work happens from without a human (FR-064). */
export const isTerminalState = (state: WorkflowState): state is TerminalOutcome =>
  (TERMINAL_WORKFLOW_STATES as readonly string[]).includes(state)

/**
 * The machine code an already-finished refusal carries. Searchable, stable, quotable in a ticket.
 */
export const ALREADY_FINISHED_CODE = 'E_WORKFLOW_ALREADY_FINISHED'

/**
 * **What FR-081 asks for: an explanation, not an error.**
 *
 * Pausing a run that finished while the page was open is not a fault on anybody's part — it is a
 * race between a human and a machine, and the human loses it several times a day. Throwing would put
 * a red banner on an ordinary event and would tell the operator nothing about *why* the button did
 * nothing. So the mutation resolves, carrying the state the run actually reached and the reason it
 * reached it, and the request is separately recorded as requested-but-not-applied on the queue row.
 */
export interface AlreadyFinishedResponse {
  readonly applied: false
  readonly alreadyFinished: true
  readonly workflowId: string
  readonly state: WorkflowState
  readonly terminalOutcome: TerminalOutcome | null
  readonly outcomeReason: string | null
  readonly recordedAt: Date
  readonly code: typeof ALREADY_FINISHED_CODE
  /** One sentence, naming the outcome. Rendered verbatim by the panel. */
  readonly explanation: string
}

/**
 * `parked_resumable` is a terminal *outcome* and a re-enterable *state* at the same time (FR-151),
 * which is why the terminal check here is not simply `isTerminalState`.
 *
 * A parked run has released its compute and persisted a snapshot; resuming it is the entire point
 * of parking, so a blanket refusal would make the platform unable to perform the one operation the
 * state exists for. Every other request against a parked run — pause it, stop it, correct it — has
 * no instance to reach and is refused with the same already-finished response as a failed run.
 *
 * @param state - The state as locked.
 * @param intent - What is being asked of the run.
 */
export const isAlreadyFinishedFor = (
  state: WorkflowState,
  intent: 'pause' | 'resume' | 'stop' | 'correction',
): boolean => {
  if (!isTerminalState(state)) {
    return false
  }

  return !(state === 'parked_resumable' && intent === 'resume')
}

/**
 * **The one state a `stop` is applied in rather than queued** (003/FR-027).
 *
 * Every other supervision command is a row an executor collects, applies and acknowledges, and the
 * workflow only reaches `cancelled` when `reportTerminal` says the run has ended. That loop is what
 * stops the panel claiming a run is stopped while the agent is still mid-turn — and it depends on
 * there being an executor.
 *
 * A run in `awaiting_credential` has none, and by construction never will until it is granted a
 * seat: it holds no instance, spends nothing, and is waiting for a credential (003/FR-024, FR-025).
 * A `stop` queued against it would sit uncollected for as long as the wait lasted, so the owner's
 * cancellation would appear to do nothing until the pool freed up — at which point the platform
 * would provision an instance for a run somebody cancelled an hour ago. FR-027 requires the
 * opposite: a waiting run must be cancellable, *terminating without ever provisioning an instance*.
 *
 * So for this one state the platform applies the command itself, in the same locked transaction
 * that decided it was admissible. Nothing is released, because nothing was held — a waiting run has
 * no compute lease and no agent-credential lease, which is the entire point of the state.
 *
 * **`queued` is deliberately not a member.** A queued run has no executor either, and the same
 * argument would extend to it, but that is 002's admission path and its own decision to make;
 * widening this list would change the behaviour of every stop pressed on a queued run as a side
 * effect of a credential-pool requirement.
 *
 * @param state - The state as locked.
 * @param intent - What is being asked of the run.
 */
export const isCancellableWithoutExecutor = (
  state: WorkflowState,
  intent: 'pause' | 'resume' | 'stop' | 'correction',
): boolean => intent === 'stop' && state === 'awaiting_credential'

const OUTCOME_PHRASING: Readonly<Record<TerminalOutcome, string>> = {
  succeeded: 'finished successfully',
  failed: 'ended in failure',
  capped: 'stopped at its turn or spend cap',
  cancelled: 'was stopped by a person',
  needs_attention: 'stopped and is waiting on a human',
  parked_resumable: 'is parked with its work snapshotted and its compute released',
}

/**
 * Build the response.
 *
 * The explanation names the outcome and, when one was recorded, the reason — because "already
 * finished" alone leaves the operator to go and find out how, which is a second click for
 * information the refusal already had in its hand.
 *
 * @param locked - The state as locked.
 * @param intent - What was asked, so the sentence says which request was not applied.
 */
export const describeAlreadyFinished = (
  locked: LockedWorkflowState,
  intent: 'pause' | 'resume' | 'stop' | 'correction',
): AlreadyFinishedResponse => {
  const outcome = locked.terminalOutcome ?? (isTerminalState(locked.state) ? locked.state : null)
  const phrase = outcome === null ? 'has already finished' : OUTCOME_PHRASING[outcome]
  const reason = locked.outcomeReason === null ? '' : ` Recorded reason: ${locked.outcomeReason}.`

  return {
    applied: false,
    alreadyFinished: true,
    workflowId: locked.id,
    state: locked.state,
    terminalOutcome: locked.terminalOutcome,
    outcomeReason: locked.outcomeReason,
    recordedAt: locked.recordedAt,
    code: ALREADY_FINISHED_CODE,
    explanation: `This run ${phrase}, so the ${intent} was recorded but not applied.${reason}`,
  }
}

/**
 * The next `sequence` for a supervision command on this workflow.
 *
 * Safe **only** under the row lock. `max(sequence) + 1` computed without it is the textbook
 * lost-update: two callers read the same maximum, both write it, and the unique index turns one of
 * them into a constraint violation on a button press.
 *
 * @param writer - The surrounding transaction, holding the workflow row lock.
 * @param workflowId - The run being supervised.
 */
export const nextCommandSequence = async (
  writer: TransitionWriter,
  workflowId: string,
): Promise<number> => {
  const rows = await writer
    .select({ highest: max(supervisionCommands.sequence) })
    .from(supervisionCommands)
    .where(eq(supervisionCommands.workflowId, workflowId))

  return (firstRow(rows)?.highest ?? 0) + 1
}

/**
 * The next `sequence` for a correction on this workflow.
 *
 * The same lost-update argument as {@link nextCommandSequence}, with a sharper consequence:
 * submission order **is** delivery order for corrections (FR-049), so a number allocated outside the
 * lock is an ordering claim nothing backs.
 *
 * @param writer - The surrounding transaction, holding the workflow row lock.
 * @param workflowId - The run being corrected.
 */
export const nextCorrectionSequence = async (
  writer: TransitionWriter,
  workflowId: string,
): Promise<number> => {
  const rows = await writer
    .select({ highest: max(corrections.sequence) })
    .from(corrections)
    .where(eq(corrections.workflowId, workflowId))

  return (firstRow(rows)?.highest ?? 0) + 1
}

/** The workflow columns a supervision response echoes back. Read after a write, inside the lock. */
export const readWorkflowRow = async (
  writer: TransitionWriter,
  workflowId: string,
): Promise<Workflow | undefined> =>
  firstRow(await writer.select().from(workflows).where(eq(workflows.id, workflowId)).limit(1))
