import { TRPCError } from '@trpc/server'
import { eq } from 'drizzle-orm'

import type { WorkflowEvent } from '../../db'
import { workflowEvents, workflows } from '../../db'
import type { ReportSnapshotParkInput, SnapshotParkDetail } from '../../schemas'
import { reportSnapshotParkInput, SNAPSHOT_PARK_WAITING_ON } from '../../schemas'
import { machineProcedure } from '../procedures'

import type { MachineContext } from './guard'
import { firstRow, isTerminalState } from './guard'

/**
 * **`machine.reportSnapshotPark` — the run is waiting on storage (T184, FR-082, FR-048).**
 *
 * ## What was missing
 *
 * `apps/sisyphus-executor/src/session/park.ts` has held a run at its turn boundary and retried an
 * unwritable snapshot since T092, and its `onParked` callback existed the whole time so that "the
 * panel can say *waiting on storage* rather than showing a stalled pause". Nothing on this surface
 * could receive that. The only consumer was a line of log text, and a line of log text is not a
 * fact anybody can query, filter, or render a state from — the panel went on showing the run as
 * `running` for the whole of a two-minute park, which is the reading FR-082 exists to prevent.
 * This is the missing end.
 *
 * ## This is *not* the `parked_resumable` outcome, and conflating them would be the whole bug
 *
 * The two are near-opposites and they are one word apart:
 *
 * | | storage park (here) | `parked_resumable` (`reportTerminal`) |
 * | --- | --- | --- |
 * | the snapshot | **could not be written** | written and registered |
 * | the instance | alive, holding a quiesced agent | released |
 * | the run | still live, still heartbeating | terminal |
 * | what to do | wait, or investigate storage | resume onto a fresh instance |
 *
 * So this resolver **does not touch `workflows.state`**. A park that flipped the run to
 * `parked_resumable` would tell the reconciler the compute had been handed back while an instance
 * was still holding it, and would tell the operator their work was safely snapshotted at the exact
 * moment it was not. The run's state stays whatever the heartbeat says it is, which is the truth:
 * the process is alive and it is working on getting its snapshot written.
 *
 * ## Why the timeline, and not a column
 *
 * A park is a sequence of attempts, each with its own timestamp, and the operationally useful
 * question is "how long has this been going on and how many tries are left" — which is a series,
 * not a value. `workflow_events` is already the append-only, attributed series the panel renders
 * (FR-064), the `parked` event already exists in its vocabulary, and a column would answer only
 * the last attempt while losing when the trouble started. The `waitingOn` discriminator in the
 * detail is what separates these entries from the terminal `parked` one — see
 * `schemas/machine.ts`.
 *
 * ## Calling twice appends twice, deliberately
 *
 * Every other procedure on this surface collapses a repeat, because the executor buffers and
 * retries it (FR-047). This one is **not** buffered and is not retried — a park report is a claim
 * about *now*, in the same family as `heartbeat`, and one replayed three minutes later would have
 * the panel announce a park that had already cleared. So there is no retry to make idempotent.
 * Collapsing on `(boundary, attempt)` would also be wrong on its own terms: attempt 1 of a pause
 * that parks, recovers, and parks again is two separate events, and merging them would erase the
 * second occurrence — the one an operator most needs to see.
 *
 * Appending twice is nevertheless harmless: nothing here is a state transition, and the read path
 * (`workflow/storage-park.ts`) takes the most recent entry.
 */

/** What `reportSnapshotPark` answers with. */
export interface SnapshotParkReport {
  /** The timeline entry that was written, or the run's last one when nothing was. */
  readonly event: WorkflowEvent | null
  /**
   * `false` when the run had already reached a terminal state and nothing was written.
   *
   * A park report arriving after the run ended is ordinary rather than an error: the instance can
   * still be alive and mid-retry when the reconciler's backstop writes an outcome. Refusing it
   * would push the executor into reporting a failure about a report, which helps nobody.
   */
  readonly recorded: boolean
}

/**
 * The `workflow_events.detail` payload for one parked attempt.
 *
 * Built through the shared type rather than an object literal, so the shape the writer stores and
 * the shape `snapshotParkDetail` parses back cannot drift apart silently.
 */
export const snapshotParkDetailFor = (input: ReportSnapshotParkInput): SnapshotParkDetail => ({
  waitingOn: SNAPSHOT_PARK_WAITING_ON,
  boundary: input.boundary,
  attempt: input.attempt,
  maxAttempts: input.maxAttempts,
  nextDelayMs: input.nextDelayMs,
  detail: input.detail ?? null,
})

/**
 * Record one parked snapshot attempt against the credential's workflow (FR-082).
 *
 * @param ctx - The machine resolver context.
 * @param input - The validated `reportSnapshotPark` payload.
 * @returns The timeline entry, and whether this call was the one that wrote it.
 * @throws {TRPCError} `NOT_FOUND` when the run no longer exists.
 */
export const reportSnapshotPark = async (
  ctx: MachineContext,
  input: ReportSnapshotParkInput,
): Promise<SnapshotParkReport> => {
  // Read outside a transaction on purpose. There is one statement to write and it is an append to
  // an append-only table, so there is nothing here two concurrent calls could interleave into a
  // wrong state — and a `for update` lock on the workflow row would put a storage outage's retry
  // loop in contention with the heartbeat that has to keep landing through it (FR-048).
  const run = firstRow(
    await ctx.db
      .select({ state: workflows.state })
      .from(workflows)
      .where(eq(workflows.id, ctx.workflowId))
      .limit(1),
  )

  if (run === undefined) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'This workflow no longer exists.' })
  }

  if (isTerminalState(run.state)) {
    return { event: null, recorded: false }
  }

  const inserted = firstRow(
    await ctx.db
      .insert(workflowEvents)
      .values({
        // Never a workflow named in the payload — there is no field for one.
        workflowId: ctx.workflowId,
        event: 'parked',
        actorType: 'executor',
        detail: snapshotParkDetailFor(input),
      })
      .returning(),
  )

  if (inserted === undefined) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'The snapshot park could not be recorded.',
    })
  }

  return { event: inserted, recorded: true }
}

/**
 * `machine.reportSnapshotPark` — ready to mount beside the other machine procedures.
 *
 * Exported rather than assembled in `router.ts`, for the reason `reportSkillReferenceProcedure` is:
 * the input schema, the resolver and the `machineProcedure` base belong together, and a router that
 * re-declares the schema is a second place for it to drift.
 */
export const reportSnapshotParkProcedure = machineProcedure.input(reportSnapshotParkInput).mutation(
  async ({ ctx, input }): Promise<SnapshotParkReport> =>
    reportSnapshotPark(
      {
        db: ctx.db,
        workflowId: ctx.workflowId,
        credential: ctx.credential,
        dependencies: ctx.dependencies,
      },
      input,
    ),
)
