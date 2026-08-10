import type { AgentCredentialReference } from '@bluetel-ai/sisyphus-api/contracts'
import type { ComputeLease, SisyphusDatabase, Workflow } from '@bluetel-ai/sisyphus-api/db'
import {
  computeLeases,
  credentialLeases,
  workflowEvents,
  workflows,
} from '@bluetel-ai/sisyphus-api/db'
import { and, count, eq, isNull, lt, or, sql } from 'drizzle-orm'

import type { WaitReason } from '../credentials/allocate'
import { describeWaitReason } from '../credentials/allocate'
import type { AcquisitionOutcome } from '../credentials/lease'
import { acquireCredential, releaseLease } from '../credentials/lease'

import { releasesAgentCredential } from './agent-credential-release'
import { latestCredentialWait, recordCredentialWait } from './credential-wait'
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
 *
 * ## The agent credential is reserved here, before any compute is committed to (003/FR-016, T046)
 *
 * Admission is the *only* place a seat in the agent-credential pool is claimed for a run, and it
 * claims one **before** the compute lease is inserted — earlier than FR-016 literally asks for,
 * which says "before any compute is provisioned". The stronger placement is free and the weaker one
 * is a trap: `compute_leases` is what the FR-040 ceiling counts, so a run holding one while it
 * waited for a seat would be occupying a concurrency slot it could not use, and T064's waiting state
 * would then have to unpick a lease this transaction had just taken. Reserving first means the
 * waiting path has nothing to undo — it simply never gets as far as the insert.
 *
 * By the time bootstrap runs on the instance, therefore, the claim is already guaranteed, and the
 * executor's `credential_install` phase can fail on transport but never on availability.
 *
 * ### Why the reservation is not a statement in this transaction
 *
 * `acquireCredential` is one transaction of its own and takes the pooled handle rather than this
 * `tx` — that is its documented contract, because re-selecting after a lost race depends on the
 * failed attempt having genuinely rolled back rather than having been unwound to a partial rollback point. So
 * the reservation runs on a **second connection while this one holds the admission lock**, and the
 * ordering below is what makes that safe:
 *
 * 1. the advisory lock is taken, so no other admission is running anywhere on the platform;
 * 2. the workflow is read **without** `FOR UPDATE`, and every reason to refuse — an existing lease,
 *    a state that is not `queued`, a full ceiling — is examined against that read;
 * 3. only then is the seat reserved, on its own connection, while this transaction holds **no row
 *    lock on `workflows` at all**;
 * 4. and only then does this transaction take `FOR UPDATE` and re-read the state.
 *
 * Step 3 sitting between 2 and 4 is not stylistic. `acquireCredential` writes
 * `workflows.agent_credential_id` and inserts a `credential_leases` row whose foreign key needs a
 * share lock on the same row, so a reservation attempted while this transaction held that row
 * `FOR UPDATE` would block on a lock it is itself inside — a deadlock with no timeout and no
 * symptom other than an admission that never returns.
 *
 * The unlocked read in step 2 is allowed to be stale, and the advisory lock is what makes it barely
 * so: no other admission can be running, so the only writer that can invalidate it is a supervision
 * action cancelling this one run, and a release elsewhere — which only ever *adds* capacity, so a
 * stale ceiling refuses conservatively and the drain comes back. Step 4 re-reads under the lock and
 * is authoritative; when it disagrees, {@link handBackSeat} returns the seat rather than stranding
 * it on a run that is not going to start.
 *
 * Checking every refusal **before** reserving is likewise deliberate. At the ceiling, admission
 * refuses constantly — every drain pass asks about every queued run — and a reservation taken
 * before that check would be acquired and handed straight back on each one, advancing the fence,
 * churning `last_used_at`, and writing a `leased`/`released` pair into the audit trail for a lease
 * that meant nothing. FR-058's trail is only worth having if the entries in it are events.
 *
 * ### What happens when the pool has nothing (T064, FR-024, FR-025)
 *
 * The run **waits**. It moves to `awaiting_credential`, takes no compute lease, and gets no
 * `admitted` entry on its timeline, because it has not been admitted — it has been told to queue
 * for a different scarce thing. SC-004 is the measurable form of that: billed compute for a waiting
 * run is zero for the entire wait, and it is zero because the insert below is never reached rather
 * than because something releases the lease afterwards. That the seat is reserved *before* the
 * compute lease is what makes this cost nothing to express: the waiting path has nothing to undo.
 *
 * The wait is entered with a **reason** ({@link import('../credentials/allocate').describeWaitReason}),
 * recorded on the timeline where the panel reads it. "No capacity" is exactly what FR-029 exists to
 * prevent: all held, all cooling off, all unhealthy and a group holding nothing at all are four
 * different situations with four different remedies, and only one of them is a queue that will
 * drain on its own.
 *
 * ### The one run that must **not** wait: no execution profile at all
 *
 * `workflows.execution_profile_id` is nullable — 002/FR-126 leaves it null for an ad-hoc run — and
 * `selectFor` reaches candidates by joining *out* through it. So a run with no profile reaches no
 * credential, and would look from here exactly like a run whose pool is full.
 *
 * It is not the same, and the difference is not a nuance: **the grant path joins through the same
 * attachments.** A run with no profile can therefore never be granted a seat by any release, by any
 * registration, or by any administrator action short of relaunching it. Putting it in
 * `awaiting_credential` would enqueue it in a queue nothing can ever serve it from, and FR-028
 * would eventually fail it naming credential exhaustion — a diagnosis that is not merely unhelpful
 * but false, since no credential was ever exhausted on its behalf.
 *
 * So a profile-less run is admitted as it was before, with the absence recorded on
 * {@link AdmittedWorkflow.agentCredential} and on its `admitted` entry, and the wait reason
 * ({@link import('../credentials/allocate').WaitReason.configurationFault}) is what tells the two
 * apart. This is also what keeps 002's ad-hoc runs working: they have never held an agent
 * credential, nothing downstream is yet ready to require one of them — the executor's
 * `credential_install` phase is T055/T056 — and stopping them now would trade a working feature for
 * a guarantee nothing is relying on. FR-024 is written over "its execution profile's attached
 * groups", and a run with no profile has none; it is outside the requirement rather than an
 * exception to it. FR-065 refuses a *profile* with no attachment at configuration time, which is
 * the same argument made one screen earlier, in front of the person who can fix it.
 *
 * `contended` is left alone and stays a retry: the pool would not settle *this attempt*, which is
 * not the same claim as "there is nothing", and putting such a run into a wait would be reporting
 * exhaustion for a pool that may well have free seats. The drain comes back.
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
  /**
   * The seat this run holds (FR-016), as the job envelope will name it — identifiers only.
   *
   * `undefined` means the run was admitted without one, which T064 makes impossible. See
   * {@link AdmittedWorkflow.reservation} for *why* there was none; the two are separate because
   * "no seat" and "no seat because the pool would not settle" call for different responses.
   */
  readonly agentCredential: AgentCredentialReference | undefined
  /** How the run came to hold — or not hold — a seat. */
  readonly reservation: AcquisitionOutcome['outcome']
}

/**
 * The pool had nothing this run can reach, so it waits (FR-024, FR-025).
 *
 * No compute lease was taken and no `admitted` entry was written, because neither happened: this is
 * not an admission with a caveat, it is a run queueing for a second scarce thing. SC-004 — zero
 * billed compute for the entire wait — is true here by construction rather than by cleanup.
 */
export interface AwaitingCredential {
  readonly outcome: 'awaiting_credential'
  readonly workflowId: string
  /** Which of the FR-029 cases applies, and the groups that were searched. */
  readonly reason: WaitReason
  /**
   * When this wait began, from the timeline entry that recorded it.
   *
   * Not "now": a drain re-examining a run that has been waiting for half an hour must report the
   * half hour, or FR-028's limit would restart on every pass and never fire.
   */
  readonly since: Date
  /** True only when *this* call moved the run into the wait; false when it was already waiting. */
  readonly entered: boolean
}

/** Someone else already holds this workflow's lease (FR-078). Not an error. */
export interface CoalescedAdmission {
  readonly outcome: 'coalesced'
  readonly workflowId: string
  readonly leaseId: string
  readonly state: Workflow['state']
}

/**
 * The ceiling was full. The run stays where it was — `queued`, or `awaiting_credential` for a
 * waiter the drain came back to — which is a wait, not a failure.
 */
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
  | AwaitingCredential
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

/**
 * The states admission may act on.
 *
 * `queued` is a run nobody has looked at yet. `awaiting_credential` is a run admission has already
 * looked at once and put into the FR-024 wait, and it is admissible for one reason: the drain
 * re-offers every waiting run on each pass, and that re-offer *is* the FR-026 grant. Nothing else
 * qualifies — a `provisioning` or `running` run has a lease, and every terminal state is over.
 *
 * Named as a list rather than written as two comparisons in each of the two places that need it,
 * because the two places are the unlocked read and the locked re-read, and a rule spelled
 * differently in those two would be a run admitted against a state the lock says it is not in.
 */
export const ADMISSIBLE_STATES = ['queued', 'awaiting_credential'] as const

/** Whether admission may act on a run in this state. */
const isAdmissibleState = (state: Workflow['state']): boolean =>
  (ADMISSIBLE_STATES as readonly string[]).includes(state)

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
 * The seat a workflow currently holds, named the way the job envelope names it (FR-012).
 *
 * Read from the live lease rather than carried through from the acquisition, and that matters in
 * two places: an acquisition that reported {@link import('../credentials/lease').AlreadyHeldCredential}
 * knows the credential but not the fence it was issued, and `start-workflow.ts` may run long after
 * admission — a retried hand-off, or the drain and the reconciler arriving together — with nothing
 * in hand but a workflow id. One read, one answer, and no way for the envelope to disagree with the
 * lease it describes.
 *
 * Exported because provisioning assembles the envelope and admission takes the seat; the read
 * belongs to whichever of them asks, not to both.
 *
 * @param reader - A pooled handle or an open transaction.
 * @param workflowId - The run.
 * @returns The reference, or `undefined` when the run holds no live lease.
 */
export const agentCredentialFor = async (
  reader: Pick<SisyphusDatabase, 'select'>,
  workflowId: string,
): Promise<AgentCredentialReference | undefined> => {
  const lease = firstRow(
    await reader
      .select({
        credentialId: credentialLeases.agentCredentialId,
        leaseFence: credentialLeases.fence,
      })
      .from(credentialLeases)
      .where(and(eq(credentialLeases.workflowId, workflowId), isNull(credentialLeases.releasedAt)))
      .limit(1),
  )

  return lease === undefined
    ? undefined
    : { credentialId: lease.credentialId, leaseFence: lease.leaseFence }
}

/** What admission did about a seat, and whether *this* admission is the one that took it. */
interface CredentialReservation {
  readonly outcome: AcquisitionOutcome['outcome']
  readonly reference: AgentCredentialReference | undefined
  /**
   * True only for a seat claimed by this call.
   *
   * The distinction is the whole of {@link handBackSeat}'s safety. A seat reported as
   * `already_held` belongs to a run that was already holding it — FR-015 gives a workflow one
   * credential for its entire lifetime — and handing that one back because *this* admission turned
   * out to be a duplicate would take an identity off a run that is very probably still using it.
   */
  readonly takenHere: boolean
}

/**
 * Claim a seat for this run, or report why there was none (FR-016).
 *
 * Runs on the pooled handle and therefore on its own connection and its own transaction — see the
 * module note for why that has to happen at the one moment this admission holds no row lock on
 * `workflows`.
 */
const reserveSeat = async (
  db: SisyphusDatabase,
  workflowId: string,
): Promise<CredentialReservation> => {
  const acquisition = await acquireCredential({ db, workflowId })

  return {
    outcome: acquisition.outcome,
    reference:
      acquisition.outcome === 'acquired' || acquisition.outcome === 'already_held'
        ? await agentCredentialFor(db, workflowId)
        : undefined,
    takenHere: acquisition.outcome === 'acquired',
  }
}

/**
 * Give back a seat this admission took for a run that turned out not to be starting.
 *
 * The window is narrow and real: the state is read without a lock, the seat is reserved, and only
 * then is the row locked and re-read. A cancellation landing in between leaves a credential claimed
 * for a run that will never use it, and nothing else would notice until the FR-022 sweep — which is
 * a reconciliation interval away and is meant to be the backstop, not the mechanism.
 *
 * **It hands nothing back that FR-019 protects.** A `queued` run can only leave that state by being
 * admitted — impossible here, the advisory lock is held — or by being cancelled, so in practice the
 * locked re-read finds a terminal state. {@link releasesAgentCredential} is consulted anyway rather
 * than assumed, because the case it exists to refuse is precisely the one a future state could
 * introduce here: a run that moved to something live keeps its seat, and the run keeps its identity.
 */
const handBackSeat = async (options: {
  readonly db: SisyphusDatabase
  readonly workflowId: string
  readonly reservation: CredentialReservation
  readonly state: Workflow['state']
}): Promise<void> => {
  if (!options.reservation.takenHere || !releasesAgentCredential(options.state)) {
    return
  }

  await releaseLease({ db: options.db, workflowId: options.workflowId, reason: 'terminal' })
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

    // Read without `FOR UPDATE`, because the reservation below cannot run while this transaction
    // holds a lock on this row — see the module note. Under the advisory lock the only writer that
    // can invalidate this read is a supervision action on this one run, and the locked re-read
    // further down is what catches that.
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
        .where(eq(workflows.id, workflowId)),
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

    // Two admissible states, not one. `awaiting_credential` is here because the grant path is this
    // same function: `drain-queue.ts` re-offers every waiting run to admission on each pass, the
    // reservation below is what tries the pool again, and a run that gets a seat this time is
    // admitted by exactly the code that admits everything else. A separate "grant" path would be a
    // second implementation of the ceiling, the row lock and the FR-078 index — three guarantees
    // that would then have to be got right twice.
    if (!isAdmissibleState(workflow.state)) {
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

    // FR-016. Every reason to refuse has now been examined and none applied, so this is the last
    // moment before the platform commits capacity to the run — and the seat is claimed here, ahead
    // of the compute lease and therefore ahead of anything that could be billed.
    const reservation = await reserveSeat(db, workflowId)

    // Only when there was nothing, and only then: this is a second, wider pass over the same graph
    // (FR-029), and a run that got a seat must not pay for a report nobody will read. `contended`
    // deliberately does not reach it either — "the pool would not settle this attempt" is not a
    // claim about what the pool holds, and classifying it would put a sentence about exhaustion on
    // a run that may be one retry from starting.
    const waitReason =
      reservation.outcome === 'none_available'
        ? await describeWaitReason(db, { workflowId })
        : undefined

    // Now, and only now, the row lock. Transitions are serialised per workflow (data-model.md,
    // FR-049/FR-081), so from here a supervision action cannot interleave with admission and leave
    // the two disagreeing about the state.
    const locked = firstRow(
      await tx
        .select({ state: workflows.state })
        .from(workflows)
        .where(eq(workflows.id, workflowId))
        .for('update'),
    )

    if (locked === undefined || !isAdmissibleState(locked.state)) {
      // Cancelled while the seat was being reserved. Hand it back rather than leaving it claimed by
      // a run that will never boot; the FR-022 sweep would eventually find it, an interval later.
      //
      // This is also the half of T066 that lives here: the drain re-offers a waiting run to
      // admission, and a `stop` that lands between the unlocked read and this lock would otherwise
      // leave a seat claimed for a run that no longer exists. The window is short and real, and the
      // only thing that closes it is re-reading the state under the lock and giving the seat back.
      const state = locked?.state ?? workflow.state
      await handBackSeat({ db, workflowId, reservation, state })

      return { outcome: 'not_admissible', workflowId, state } satisfies NotAdmissible
    }

    // FR-024, FR-025 — the wait. No compute lease is inserted below, so SC-004's "zero billed
    // compute for the entire wait" holds because nothing was taken, not because something is
    // released later.
    //
    // The one exception is a run that cannot be *served* by waiting at all. See the module note:
    // the grant path joins waiting runs to their execution profile's attachments, so a run with no
    // profile is one nothing can ever be granted to, and enqueueing it would only guarantee that
    // FR-028 eventually fails it naming an exhaustion that never happened. Such a run is admitted
    // as it always was, with the absence on its record.
    if (waitReason?.grantable === true) {
      const recorded = await latestCredentialWait(tx, workflowId)

      // Already waiting, and re-offered by the drain: leave the state, leave the timeline alone,
      // and report the wait from when it *began*. Re-recording here would restart FR-028's clock
      // on every pass, so the limit would never fire and the panel would say a run that has waited
      // an hour has waited four seconds.
      if (locked.state === 'awaiting_credential' && recorded?.since !== undefined) {
        return {
          outcome: 'awaiting_credential',
          workflowId,
          reason: waitReason,
          since: recorded.since,
          entered: false,
        } satisfies AwaitingCredential
      }

      await tx
        .update(workflows)
        .set({ state: 'awaiting_credential' })
        .where(eq(workflows.id, workflowId))

      // In the same transaction as the state change, because they are one fact: a run in
      // `awaiting_credential` with no record of when it started waiting has no clock for FR-028
      // and no explanation for FR-029.
      const since = await recordCredentialWait(tx, { workflowId, reason: waitReason })

      return {
        outcome: 'awaiting_credential',
        workflowId,
        reason: waitReason,
        since,
        entered: true,
      } satisfies AwaitingCredential
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
      // The seat is deliberately **not** handed back here. A run holding a live compute lease is a
      // run that is starting or already started, and FR-015 gives it one credential for its whole
      // lifetime; the acquisition above will have reported `already_held` rather than taken a
      // second one, so there is nothing this admission owns to give back.
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
      detail: {
        ceiling,
        liveLeasesBefore: liveLeases,
        // The seat, on the run's own timeline. Recorded even when there was none, because a run
        // that started without one is precisely what the waiting state exists to prevent, and the
        // two remaining ways to reach here without one — a run with no execution profile, and a
        // pool that would not settle — are worth being able to tell apart afterwards.
        agentCredentialId: reservation.reference?.credentialId ?? null,
        credentialReservation: reservation.outcome,
        credentialWaitReason: waitReason?.kind ?? null,
      },
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
      agentCredential: reservation.reference,
      reservation: reservation.outcome,
    } satisfies AdmittedWorkflow
  })
}

/** Admission wrapped in the uniform job envelope. */
export const runAdmitWorkflow = (
  options: AdmitWorkflowOptions,
): Promise<JobOutcome<AdmissionOutcome>> =>
  runJob(ADMIT_WORKFLOW_JOB_NAME, () => admitWorkflow(options))
