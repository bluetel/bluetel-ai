import type { ComputeLease, SisyphusDatabase, Workflow } from '@bluetel-ai/sisyphus-api/db'
import { computeLeases, workflowEvents, workflows } from '@bluetel-ai/sisyphus-api/db'
import { and, count, eq, isNull, lt, or, sql } from 'drizzle-orm'

import type { JobOutcome } from './run-job'
import { runJob } from './run-job'

/**
 * Admission — the decision that turns a `queued` workflow into a `provisioning` one (T050, FR-040).
 *
 * **The ceiling is counted against `compute_leases`, never against workflow rows.** A lease is what
 * costs money. A workflow sitting in `queued` holds nothing, and refusing work on account of it
 * would leave paid-for capacity idle; a workflow whose instance is still winding down holds a lease
 * and very much does cost, and ignoring it would overshoot the ceiling by however many runs happen
 * to be terminating. Counting the row instead of the lease gets both cases wrong, in opposite
 * directions.
 *
 * **It writes the database directly rather than going through the in-process caller.** There is no
 * workflow procedure to call: `appRouter` mounts `health` and `admin`, and the panel's eventual
 * `start` mutation writes a `queued` row and returns — provisioning is deliberately not reachable
 * from it (FR-035, plan.md "How the panel reaches the control plane"). Even once a workflow router
 * exists, admission would not fit behind it: the ceiling count, the row lock and the lease insert
 * have to be one transaction, and a caller boundary cannot express that. The same argument
 * `bootstrap-admins.ts` makes about `admin.users.setRole`, one requirement along.
 *
 * ## The race, and why an advisory lock rather than a careful count
 *
 * Two admissions arriving together under READ COMMITTED both see the pre-transaction count.
 * `select count(*) … where released_at is null` takes no lock and blocks nothing, so at
 * `ceiling - 1` both would read "one slot left" and both would take it. The count is not wrong; it
 * is simply not a decision anyone else is waiting on.
 *
 * So admission serialises on a transaction-scoped advisory lock. Every admitting transaction takes
 * {@link ADMISSION_LOCK_CLASS}/{@link ADMISSION_LOCK_KEY} before it counts, so the second one
 * *blocks* until the first commits and then counts a world that includes the first one's lease.
 * The lock is transaction-scoped, so it is released by commit or rollback and cannot be leaked by a
 * process that dies mid-admission. `admit-workflow.test.ts` proves the block rather than assuming
 * it, by watching for a backend parked on a lock in `pg_stat_activity`.
 *
 * Serialising every admission platform-wide is the cost, and it is the right one: admission is a
 * short transaction that happens once per run, and the thing being protected *is* a single global
 * counter.
 *
 * The FR-078 duplicate-start rule is enforced one layer down, on
 * `compute_leases_live_key` — the partial unique index on `(workflow_id) WHERE released_at IS
 * NULL`. A second admission for the same workflow loses on the index and is reported as
 * {@link CoalescedAdmission}, not as an error: a double-clicked launch button is a duplicate
 * request, not a failure.
 */

/**
 * Advisory-lock namespace for platform-wide serialisation points. FR-120's per-repository lock uses
 * a different class, so the two key spaces cannot collide however the repository key is hashed.
 */
export const ADMISSION_LOCK_CLASS = 1

/** The admission slot inside {@link ADMISSION_LOCK_CLASS}. `40` for FR-040, so the trail is short. */
export const ADMISSION_LOCK_KEY = 40

export const ADMIT_WORKFLOW_JOB_NAME = 'admit-workflow'

/** What admission needs from a handle — satisfied by a pool or by an open transaction. */
export type AdmissionWriter = Pick<SisyphusDatabase, 'execute' | 'insert' | 'select' | 'update'>

/** The workflow was admitted by *this* transaction, and it alone holds the new lease. */
export interface AdmittedWorkflow {
  readonly outcome: 'admitted'
  readonly workflowId: string
  readonly leaseId: string
  /** Zero: an admitted workflow is not waiting. */
  readonly queuePosition: 0
  /** Live leases including the one just taken. */
  readonly liveLeases: number
  readonly ceiling: number
  readonly instanceType: string
  readonly purchaseMode: ComputeLease['purchaseMode']
}

/** Someone else already holds this workflow's lease (FR-078). Not an error. */
export interface CoalescedAdmission {
  readonly outcome: 'coalesced'
  readonly workflowId: string
  readonly leaseId: string
  readonly state: Workflow['state']
}

/** The ceiling was full. The run stays `queued`, which is a wait, not a failure. */
export interface QueuedAdmission {
  readonly outcome: 'queued'
  readonly workflowId: string
  /** One-based place in the queue, oldest first — what the panel shows so a wait is legible. */
  readonly queuePosition: number
  readonly liveLeases: number
  readonly ceiling: number
}

/** The workflow is not in a state admission may act on — cancelled, failed, already running. */
export interface NotAdmissible {
  readonly outcome: 'not_admissible'
  readonly workflowId: string
  readonly state: Workflow['state']
}

export type AdmissionOutcome =
  | AdmittedWorkflow
  | CoalescedAdmission
  | NotAdmissible
  | QueuedAdmission

/**
 * The provisioning seam — implemented by `jobs/start-workflow.ts` (T052), which sizes and prices
 * the instance, assembles the user-data envelope and mints the workflow-scoped credential (T053).
 *
 * Admission does not call it: provisioning happens **after** the admitting transaction commits, so
 * that a slow launch cannot hold the platform-wide admission lock, and so that a launch failure
 * rolls back nothing — the lease stands and the reconciler (T067) is the backstop. {@link drainQueue}
 * takes an implementation and calls it per admitted workflow.
 */
export interface WorkflowStarter {
  readonly start: (input: AdmittedWorkflow) => Promise<void>
}

export interface AdmitWorkflowOptions {
  readonly db: SisyphusDatabase
  readonly workflowId: string
  /**
   * Read at admission from deploy-time configuration — see `concurrency-ceiling.ts`. Passed in
   * rather than read here, so the value under test is the value under test.
   */
  readonly ceiling: number
}

/**
 * The first row, honestly typed.
 *
 * `noUncheckedIndexedAccess` is off in this workspace, so `rows[0]` is typed as present even when
 * the result set is empty, and a `=== undefined` guard against it is narrowed away as unreachable.
 * A function whose declared return type admits `undefined` restores the check.
 */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

interface QueuedWorkflowRow {
  readonly id: string
  readonly state: Workflow['state']
  readonly createdAt: Date
  readonly instanceType: string
  readonly purchaseMode: ComputeLease['purchaseMode']
}

/**
 * Where this workflow stands in the queue, oldest first.
 *
 * Ordered by `created_at` with the id as tie-break — ids are UUID v7, so the tie-break is itself
 * chronological rather than arbitrary. Two runs created in the same microsecond therefore still
 * have a stable order, and the position the panel shows does not shuffle between reads.
 */
const queuePositionOf = async (
  writer: AdmissionWriter,
  workflow: QueuedWorkflowRow,
): Promise<number> => {
  const ahead = firstRow(
    await writer
      .select({ value: count() })
      .from(workflows)
      .where(
        and(
          eq(workflows.state, 'queued'),
          or(
            lt(workflows.createdAt, workflow.createdAt),
            and(eq(workflows.createdAt, workflow.createdAt), lt(workflows.id, workflow.id)),
          ),
        ),
      ),
  )

  return (ahead?.value ?? 0) + 1
}

/** The live lease for one workflow, if it has one. */
const liveLeaseFor = async (
  writer: AdmissionWriter,
  workflowId: string,
): Promise<string | undefined> => {
  const rows = await writer
    .select({ id: computeLeases.id })
    .from(computeLeases)
    .where(and(eq(computeLeases.workflowId, workflowId), isNull(computeLeases.releasedAt)))
    .limit(1)

  return firstRow(rows)?.id
}

/** Live leases platform-wide — the FR-040 count, taken inside the admitting transaction. */
export const countLiveLeases = async (writer: AdmissionWriter): Promise<number> => {
  const rows = await writer
    .select({ value: count() })
    .from(computeLeases)
    .where(isNull(computeLeases.releasedAt))

  return firstRow(rows)?.value ?? 0
}

/**
 * Admit one workflow, or say why not.
 *
 * @param options - The database handle, the workflow, and the ceiling in force at this moment.
 * @returns Which of the four things happened, with the queue position in the two cases where a
 *   position means anything.
 * @throws If the workflow does not exist, or the ceiling is not a positive integer — an absent
 *   workflow means the caller's queue read and the database disagree, and admitting under a
 *   nonsense ceiling would silently provision without a bound.
 */
export const admitWorkflow = async (options: AdmitWorkflowOptions): Promise<AdmissionOutcome> => {
  const { ceiling, db, workflowId } = options

  if (!Number.isInteger(ceiling) || ceiling < 1) {
    throw new Error(
      `The concurrency ceiling must be a positive integer; received ${String(ceiling)}. Admitting under an unusable ceiling would provision without a bound, which is the one thing FR-040 exists to prevent.`,
    )
  }

  /* cspell:ignore xact */
  return db.transaction(async (tx) => {
    // Before the count, not after: this is what makes the count a decision no other admission can
    // be halfway through making. See the note at the top of this file.
    await tx.execute(
      sql`select pg_advisory_xact_lock(${ADMISSION_LOCK_CLASS}, ${ADMISSION_LOCK_KEY})`,
    )

    const workflow = firstRow(
      await tx
        .select({
          id: workflows.id,
          state: workflows.state,
          createdAt: workflows.createdAt,
          instanceType: workflows.instanceType,
          purchaseMode: workflows.purchaseMode,
        })
        .from(workflows)
        .where(eq(workflows.id, workflowId))
        // Transitions are serialised per workflow (data-model.md, FR-049/FR-081), so a supervision
        // action cannot interleave with admission and leave the two disagreeing about the state.
        .for('update'),
    )

    if (workflow === undefined) {
      throw new Error(
        `Workflow ${workflowId} does not exist, so there is nothing to admit. A caller that read it from the queue and cannot find it now is looking at a different database.`,
      )
    }

    const existingLease = await liveLeaseFor(tx, workflowId)
    if (existingLease !== undefined) {
      return {
        outcome: 'coalesced',
        workflowId,
        leaseId: existingLease,
        state: workflow.state,
      } satisfies CoalescedAdmission
    }

    if (workflow.state !== 'queued') {
      return {
        outcome: 'not_admissible',
        workflowId,
        state: workflow.state,
      } satisfies NotAdmissible
    }

    const liveLeases = await countLiveLeases(tx)

    if (liveLeases >= ceiling) {
      return {
        outcome: 'queued',
        workflowId,
        queuePosition: await queuePositionOf(tx, workflow),
        liveLeases,
        ceiling,
      } satisfies QueuedAdmission
    }

    const lease = firstRow(
      await tx
        .insert(computeLeases)
        .values({
          workflowId,
          instanceType: workflow.instanceType,
          purchaseMode: workflow.purchaseMode,
        })
        // `provider_instance_id` stays null until provisioning gives us one: the lease is taken at
        // admission because that is when the capacity is committed to, not when EC2 answers.
        .onConflictDoNothing({
          target: computeLeases.workflowId,
          where: isNull(computeLeases.releasedAt),
        })
        .returning({ id: computeLeases.id }),
    )

    if (lease === undefined) {
      // Lost on `compute_leases_live_key` (FR-078). The workflow row lock above should have made
      // this unreachable; it is handled anyway, because the index is the guarantee and the lock is
      // only the ordering.
      const raced = await liveLeaseFor(tx, workflowId)
      if (raced === undefined) {
        throw new Error(
          `Workflow ${workflowId} could neither take a compute lease nor be shown to already hold one. Provisioning against that state would risk a second instance for one run (FR-078).`,
        )
      }
      return {
        outcome: 'coalesced',
        workflowId,
        leaseId: raced,
        state: workflow.state,
      } satisfies CoalescedAdmission
    }

    await tx.update(workflows).set({ state: 'provisioning' }).where(eq(workflows.id, workflowId))

    await tx.insert(workflowEvents).values({
      workflowId,
      event: 'admitted',
      actorType: 'control_plane',
      detail: { ceiling, liveLeasesBefore: liveLeases },
    })

    return {
      outcome: 'admitted',
      workflowId,
      leaseId: lease.id,
      queuePosition: 0,
      liveLeases: liveLeases + 1,
      ceiling,
      instanceType: workflow.instanceType,
      purchaseMode: workflow.purchaseMode,
    } satisfies AdmittedWorkflow
  })
}

/** Admission wrapped in the uniform job envelope. */
export const runAdmitWorkflow = (
  options: AdmitWorkflowOptions,
): Promise<JobOutcome<AdmissionOutcome>> =>
  runJob(ADMIT_WORKFLOW_JOB_NAME, () => admitWorkflow(options))
