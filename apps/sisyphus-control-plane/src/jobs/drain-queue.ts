import type { SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'
import { workflows } from '@bluetel-ai/sisyphus-api/db'
import { asc, count, eq } from 'drizzle-orm'

import type { AdmittedWorkflow, WorkflowStarter } from './admit-workflow'
import { admitWorkflow, countLiveLeases } from './admit-workflow'
import type { JobOutcome } from './run-job'
import { runJob, toError } from './run-job'

/**
 * The queue drain (T051) — re-admitting queued work when a lease releases.
 *
 * Without it the FR-040 ceiling builds a queue nothing empties: admission refuses at the ceiling
 * and returns a position, but nothing re-examines that position when capacity frees up, so a run
 * that was one place from the front would sit there until someone launched another workflow and
 * happened to admit it instead. That sentence is the entire justification for the task, so the
 * tests here are about the queue actually emptying, in order.
 *
 * **Who calls it.** Teardown (T066) after it releases a lease, the reconciler (T067) after it
 * releases a leaked one, and the EventBridge schedule that drives every control-plane job — the
 * control plane has no inbound surface, so a timer is the backstop for a release that happened
 * while nothing was listening (FR-035, plan.md "How the panel reaches the control plane").
 *
 * ## Why a concurrent drain cannot double-admit
 *
 * The drain takes no lock of its own, and does not need one. It selects candidates optimistically
 * and then calls {@link admitWorkflow} per candidate, and admission is the thing that is atomic:
 * each attempt takes the platform-wide advisory lock, locks the workflow row, and inserts against
 * `compute_leases_live_key` — the partial unique index on `(workflow_id) WHERE released_at IS
 * NULL`. Two drains racing on the same candidate therefore produce one `admitted` and one
 * `coalesced`, because only the transaction that *inserted* the lease reports `admitted`. The
 * drain counts admissions, never coalesces, so the same workflow cannot be admitted twice and
 * cannot be started twice.
 *
 * A drain-wide lock would have been the obvious alternative and is worse: it would have to be
 * session-scoped to span several transactions, and a session-scoped lock over a connection pool is
 * a lock taken on one backend and released on another. The correctness here belongs to the index,
 * which does not care how many processes are sweeping.
 */

export const DRAIN_QUEUE_JOB_NAME = 'drain-queue'

/**
 * How many admissions one drain will attempt.
 *
 * A bound rather than a batch size: the drain stops at the ceiling anyway, so this only limits how
 * long one invocation runs when leases are being released as fast as they are taken.
 */
export const DEFAULT_DRAIN_LIMIT = 25

export interface DrainQueueOptions {
  readonly db: SisyphusDatabase
  /** The ceiling in force, read at admission from deploy-time configuration (FR-040). */
  readonly ceiling: number
  /** Provisioning (T052), called per admitted workflow after its transaction commits. */
  readonly starter?: WorkflowStarter
  /** Maximum admissions to attempt in one invocation. Defaults to {@link DEFAULT_DRAIN_LIMIT}. */
  readonly limit?: number
}

/** A workflow that was admitted but whose provisioning hand-off threw. */
export interface DrainStartFailure {
  readonly workflowId: string
  readonly error: Error
}

export interface DrainQueueResult {
  /** Admitted by *this* drain, in admission order. Never includes a coalesced attempt. */
  readonly admitted: readonly AdmittedWorkflow[]
  /** Workflows still `queued` after the drain. */
  readonly remainingQueued: number
  /** The drain stopped because the ceiling was full rather than because the queue emptied. */
  readonly ceilingReached: boolean
  /**
   * Admitted, but the hand-off to provisioning failed. The lease stands and the workflow is
   * `provisioning`, which is precisely the state the FR-039 reconciler exists to resolve — losing
   * the failure here would leave a lease nobody knows to release.
   */
  readonly startFailures: readonly DrainStartFailure[]
}

/** See `admit-workflow.ts`: `noUncheckedIndexedAccess` is off, so indexing needs an honest type. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/**
 * Queued workflow ids, oldest first.
 *
 * Read outside any transaction and deliberately treated as a hint: by the time an admission gets
 * to a candidate it may have been cancelled or admitted by another drain, and `admitWorkflow`
 * says so rather than trusting this list.
 */
const queuedWorkflowIds = async (
  db: SisyphusDatabase,
  limit: number,
): Promise<readonly string[]> => {
  const rows = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(eq(workflows.state, 'queued'))
    // Admission order: oldest first, tie-broken by the UUID v7 id, which is itself chronological.
    .orderBy(asc(workflows.createdAt), asc(workflows.id))
    .limit(limit)

  return rows.map((row) => row.id)
}

const countQueued = async (db: SisyphusDatabase): Promise<number> => {
  const rows = await db
    .select({ value: count() })
    .from(workflows)
    .where(eq(workflows.state, 'queued'))

  return firstRow(rows)?.value ?? 0
}

/**
 * Admit as much queued work as the ceiling allows, oldest first.
 *
 * @param options - The handle, the ceiling, and optionally the provisioning seam to hand each
 *   admitted workflow to.
 * @returns What was admitted, what is still waiting, and whether the ceiling or the queue ended it.
 */
export const drainQueue = async (options: DrainQueueOptions): Promise<DrainQueueResult> => {
  const { ceiling, db, starter } = options
  const limit = options.limit ?? DEFAULT_DRAIN_LIMIT

  const admitted: AdmittedWorkflow[] = []
  const startFailures: DrainStartFailure[] = []
  let ceilingReached = false

  // A cheap pre-check: at the ceiling there is nothing to attempt, and every attempt would take the
  // platform-wide admission lock only to read the same count. The authoritative check is still the
  // one inside each admitting transaction — this one is allowed to be stale.
  if ((await countLiveLeases(db)) >= ceiling) {
    return {
      admitted,
      remainingQueued: await countQueued(db),
      ceilingReached: true,
      startFailures,
    }
  }

  for (const workflowId of await queuedWorkflowIds(db, limit)) {
    const outcome = await admitWorkflow({ db, workflowId, ceiling })

    if (outcome.outcome === 'queued') {
      // The ceiling filled while this drain was running — every later candidate is behind this one,
      // so there is no point asking about them.
      ceilingReached = true
      break
    }

    if (outcome.outcome !== 'admitted') {
      // `coalesced` or `not_admissible`: another drain got there, or the run was cancelled while
      // this drain was reading. Neither is this drain's admission, and neither is an error.
      continue
    }

    admitted.push(outcome)

    if (starter !== undefined) {
      try {
        await starter.start(outcome)
      } catch (thrown) {
        startFailures.push({ workflowId, error: toError(thrown) })
      }
    }
  }

  return {
    admitted,
    remainingQueued: await countQueued(db),
    ceilingReached,
    startFailures,
  }
}

/** The drain wrapped in the uniform job envelope. */
export const runDrainQueue = (options: DrainQueueOptions): Promise<JobOutcome<DrainQueueResult>> =>
  runJob(DRAIN_QUEUE_JOB_NAME, () => drainQueue(options))
