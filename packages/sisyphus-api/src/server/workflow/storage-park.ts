import { and, desc, eq, sql } from 'drizzle-orm'

import type { SisyphusDatabase, Workflow } from '../../db'
import { workflowEvents } from '../../db'
import type { SnapshotBoundary, WorkflowState } from '../../enums'
import { TERMINAL_WORKFLOW_STATES } from '../../enums'
import { SNAPSHOT_PARK_WAITING_ON, snapshotParkDetail } from '../../schemas'

/**
 * **The read half of "this run is waiting on storage" (T184, FR-082).**
 *
 * `machine.reportSnapshotPark` writes one `parked` timeline entry per failed snapshot attempt.
 * That is enough for the timeline card, which renders events, and not enough for anything else:
 * "is this run waiting on storage **right now**, and how many tries has it had" is a question
 * about the *latest* entry weighed against what happened after it, and no consumer should be
 * re-deriving that from a list of events. This module is the one derivation.
 *
 * ## A park ends without an event of its own, and that is on purpose
 *
 * Nothing reports that a park has ended. Two things end one, and both already write to the
 * timeline:
 *
 * - the retry succeeds — `registerSnapshot` writes `snapshot_registered`, which is the *proof* the
 *   write got through, not a claim about it;
 * - the budget is exhausted, or anything else ends the run — `reportTerminal` writes the outcome,
 *   naming the boundary it could not persist.
 *
 * Adding a third report would mean the panel's answer depended on a message that arrives exactly
 * when the network is least trustworthy: the one case a park has to be reported *out of* is the
 * case where the instance has just died. Deriving it instead means a run whose instance vanished
 * mid-park stops reading as waiting the moment the reconciler records the outcome, with nothing
 * needing to have been delivered from the instance at all (FR-039, FR-048).
 */

/**
 * The first row, honestly typed.
 *
 * `noUncheckedIndexedAccess` is off in this project, so `rows[0]` is typed as present even when
 * the result set is empty, and a `=== undefined` guard against it is narrowed away as unreachable.
 */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/** One recorded park, and whether it is still the run's current situation. */
export interface StoragePark {
  /** Which boundary could not be written. */
  readonly boundary: SnapshotBoundary
  /** 1-based, and the attempt that **failed**. */
  readonly attempt: number
  readonly maxAttempts: number
  /** How long the instance waits before the next attempt. */
  readonly nextDelayMs: number
  /** Why the write failed, as the executor sanitised it. Null when none was given. */
  readonly detail: string | null
  readonly reportedAt: Date
  /**
   * True while the run is still holding: nothing has been snapshotted since, and it has not ended.
   *
   * A `false` here is what stops the panel announcing a park that cleared ten minutes ago. It is
   * still worth returning the row rather than `null` — "this run parked and then recovered" is a
   * fact about the run, and it is the explanation for a gap in the log.
   */
  readonly waiting: boolean
}

/**
 * Whether a recorded park is still in force.
 *
 * Pure, and separated from the query for the usual reason: this is the rule, and a rule embedded
 * in a `select` is a rule that gets asserted by seeding a database rather than by being read.
 *
 * @param options.parkedAt - When the latest park attempt was recorded.
 * @param options.snapshotRegisteredAt - When a snapshot was last registered, or null for never.
 * @param options.state - The run's current state.
 */
export const isWaitingOnStorage = (options: {
  readonly parkedAt: Date
  readonly snapshotRegisteredAt: Date | null
  readonly state: WorkflowState
}): boolean => {
  if ((TERMINAL_WORKFLOW_STATES as readonly string[]).includes(options.state)) {
    return false
  }

  // Strictly `<`, so a registration in the same millisecond as the last failed attempt counts as
  // having landed. The two events are one retry apart and can share a timestamp; of the two ways
  // to break the tie, claiming a run is stuck when its work is safe is the worse.
  return (
    options.snapshotRegisteredAt === null ||
    options.snapshotRegisteredAt.getTime() < options.parkedAt.getTime()
  )
}

/** The most recent `workflow_events.created_at` for one event, or null when there is none. */
const latestEventAt = async (
  db: Pick<SisyphusDatabase, 'select'>,
  workflowId: string,
  event: 'snapshot_registered',
): Promise<Date | null> => {
  const rows = await db
    .select({ createdAt: workflowEvents.createdAt })
    .from(workflowEvents)
    .where(and(eq(workflowEvents.workflowId, workflowId), eq(workflowEvents.event, event)))
    .orderBy(desc(workflowEvents.createdAt), desc(workflowEvents.id))
    .limit(1)

  return firstRow(rows)?.createdAt ?? null
}

/**
 * The run's latest storage park, or null if it has never parked (FR-082).
 *
 * **Not scoped, and must not be reached directly by a resolver.** It takes a workflow row that
 * `requireWorkflowInScope` has already admitted, exactly as `loadLaunchConfiguration` does — the
 * FR-190 rule is that no statement touching `workflows` runs unscoped, and this one does not touch
 * `workflows` at all.
 *
 * The `waitingOn` predicate is what separates these entries from the terminal `parked` one
 * `reportTerminal` writes for a `parked_resumable` outcome. Those are near-opposite situations
 * sharing an event name, and a reader that matched on the name alone would report a run whose work
 * is safely snapshotted and whose compute is released as one that cannot write to storage.
 *
 * @param db - The database handle.
 * @param workflow - The run, already admitted by the caller's scope.
 */
export const readStoragePark = async (
  db: Pick<SisyphusDatabase, 'select'>,
  workflow: Pick<Workflow, 'id' | 'state'>,
): Promise<StoragePark | null> => {
  const rows = await db
    .select({ detail: workflowEvents.detail, createdAt: workflowEvents.createdAt })
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.workflowId, workflow.id),
        eq(workflowEvents.event, 'parked'),
        sql`${workflowEvents.detail} ->> 'waitingOn' = ${SNAPSHOT_PARK_WAITING_ON}`,
      ),
    )
    .orderBy(desc(workflowEvents.createdAt), desc(workflowEvents.id))
    .limit(1)

  const row = firstRow(rows)

  if (row === undefined) {
    return null
  }

  // Parsed rather than cast. `detail` is `jsonb`, so it arrives as `unknown`, and a row written by
  // an older executor is a real possibility on a long-lived deployment. A detail this schema
  // cannot read is treated as no park on record — saying nothing is right where the alternative is
  // a card rendering `undefined of undefined`.
  const parsed = snapshotParkDetail.safeParse(row.detail)

  if (!parsed.success) {
    return null
  }

  const snapshotRegisteredAt = await latestEventAt(db, workflow.id, 'snapshot_registered')

  return {
    boundary: parsed.data.boundary,
    attempt: parsed.data.attempt,
    maxAttempts: parsed.data.maxAttempts,
    nextDelayMs: parsed.data.nextDelayMs,
    detail: parsed.data.detail,
    reportedAt: row.createdAt,
    waiting: isWaitingOnStorage({
      parkedAt: row.createdAt,
      snapshotRegisteredAt,
      state: workflow.state,
    }),
  }
}
