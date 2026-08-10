import type { SisyphusDatabase, Workflow } from '@bluetel-ai/sisyphus-api/db'
import { workflowEvents, workflows } from '@bluetel-ai/sisyphus-api/db'
import type { WorkflowNotifier } from '@bluetel-ai/sisyphus-notify'
import { notificationEventForState } from '@bluetel-ai/sisyphus-notify'
import { asc, count, eq, inArray } from 'drizzle-orm'

import type { WaitReason } from '../credentials/allocate'
import { describeWaitReason } from '../credentials/allocate'

import type { AdmittedWorkflow, AwaitingCredential, WorkflowStarter } from './admit-workflow'
import { ADMISSIBLE_STATES, admitWorkflow, countLiveLeases } from './admit-workflow'
import { latestCredentialWait } from './credential-wait'
import type { JobOutcome } from './run-job'
import { runJob, toError } from './run-job'

/**
 * The queue drain (T051) — re-admitting queued work when a lease releases, and **granting a freed
 * agent credential to the longest-waiting run that can use it** (T065, FR-026).
 *
 * Without it the FR-040 ceiling builds a queue nothing empties: admission refuses at the ceiling
 * and returns a position, but nothing re-examines that position when capacity frees up, so a run
 * that was one place from the front would sit there until someone launched another workflow and
 * happened to admit it instead. That sentence is the entire justification for the task, so the
 * tests here are about the queue actually emptying, in order.
 *
 * **Who calls it.** Teardown (T066) after it releases a lease, the reconciler (T067) after it
 * releases a leaked one — including a leaked **seat**, which is why it drains on
 * `releasedSeats.length > 0` too — and the EventBridge schedule that drives every control-plane
 * job. The control plane has no inbound surface, so a timer is the backstop for a release that
 * happened while nothing was listening (FR-035, plan.md "How the panel reaches the control plane").
 *
 * ## One queue or two? One pass, over both scarcities
 *
 * There are two ways to be waiting here and they are genuinely different: `queued` is a run held
 * back by the FR-040 concurrency ceiling, and `awaiting_credential` is a run held back by the agent
 * credential pool (FR-024). This drain walks **both**, in one pass, in `created_at` order.
 *
 * That is not a convenience. FR-026 wants a released credential granted to the longest-waiting run
 * that can reach it, and the drain is the only thing that looks at the waiting set — so the grant
 * has to happen here or in a second job that would need the same ordering, the same reachability
 * rule and the same ceiling. Running one ordered pass means "oldest first" is one comparison rather
 * than a policy about which queue goes first.
 *
 * ## The grant is `admitWorkflow`, called again
 *
 * A waiting run is offered to admission exactly like a queued one, and admission does the rest: it
 * counts the ceiling, reserves a seat if one is now free, takes the row lock, and inserts the
 * compute lease. `awaiting_credential` is admissible for this reason alone (see
 * {@link ADMISSIBLE_STATES}). A dedicated grant path would have been a second implementation of the
 * platform-wide admission lock, the FR-078 uniqueness index and the hand-back on a cancelled run —
 * three guarantees that would then have to be right twice.
 *
 * **Reachability is not a filter this file applies; it is what the reservation *is*.** Acquisition
 * selects through `selectFor`, which joins out from the workflow to its own execution profile's
 * attached groups, so a run is only ever offered a credential it can use. A waiter that cannot
 * reach the seat that just freed simply comes back `awaiting_credential` again — and this loop
 * **continues to the next candidate** instead of stopping. That `continue` is SC-017: saturating
 * one group must not stall profiles attached elsewhere, and a drain that treated "this run is still
 * waiting" as "the queue is blocked" would have one team's exhausted pool hold up every other
 * team's runs behind it.
 *
 * ## Why a concurrent drain cannot double-admit, or grant one seat twice
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
 * The seat has its own two guarantees underneath the same call: the conditional
 * `UPDATE … WHERE state = 'available'` and `credential_leases_live_key`. Two drains that both
 * decide to grant the same freed credential produce one acquisition and one `none_available`, and
 * the loser reports its run as still waiting rather than as holding a seat somebody else has.
 *
 * A drain-wide lock would have been the obvious alternative and is worse: it would have to be
 * session-scoped to span several transactions, and a session-scoped lock over a connection pool is
 * a lock taken on one backend and released on another. The correctness here belongs to the indexes,
 * which do not care how many processes are sweeping.
 *
 * ## The cancelled-in-the-same-moment race (T066)
 *
 * A run can be stopped between this drain reading it as a candidate and admission acting on it, and
 * the seat must be **neither lost nor granted twice**. Both halves are handled one layer down and
 * are worth naming here because this is where the race is observed:
 *
 * - *not lost* — admission reserves the seat, then takes the row lock and re-reads the state. A run
 *   that is no longer admissible has the seat handed straight back (`handBackSeat`), so a
 *   cancellation landing inside the window costs one fence increment and nothing else. Without that
 *   re-read the credential would sit claimed by a workflow that will never boot until the FR-022
 *   sweep noticed, a reconciliation interval later.
 * - *not granted twice* — the run is not in `admitted`, so this drain never hands it to
 *   provisioning, and `credential_leases_workflow_live_key` refuses a second live lease for one
 *   workflow however many drains ask.
 *
 * ## Expiring a wait (T067, FR-028)
 *
 * A wait cannot be unbounded. A run waiting past `SISYPHUS_CREDENTIAL_WAIT_LIMIT_MINUTES` is failed
 * **naming credential exhaustion and recording how long it waited** — the duration on the outcome
 * reason and on the timeline entry, because "failed: no credential" tells an operator nothing about
 * whether the pool is one seat short or entirely broken. The reason is recomputed at that moment
 * rather than read off the entry the wait began with: an hour is long enough for the pool to have
 * changed, and the sentence recorded on a terminal run is the one somebody will read months later.
 *
 * Expiry runs **before** the admission pass and independently of the ceiling, so a full ceiling
 * cannot postpone it indefinitely, and it releases nothing: a waiting run holds no compute lease and
 * no seat, which is the whole point of the state (FR-025, FR-027).
 */

export const DRAIN_QUEUE_JOB_NAME = 'drain-queue'

/**
 * How many admissions one drain will attempt.
 *
 * A bound rather than a batch size: the drain stops at the ceiling anyway, so this only limits how
 * long one invocation runs when leases are being released as fast as they are taken.
 */
export const DEFAULT_DRAIN_LIMIT = 25

/**
 * How long a run may wait for an agent credential before it is failed (FR-028).
 *
 * Sixty minutes, matching `SISYPHUS_CREDENTIAL_WAIT_LIMIT_MINUTES`'s default in `env-schemas.ts`.
 * The deployed value is read there and passed in, exactly as the ceiling is — a job that read its
 * own configuration would be a job whose tests cannot choose the value under test.
 */
export const DEFAULT_CREDENTIAL_WAIT_LIMIT_MS = 60 * 60 * 1000

export interface DrainQueueOptions {
  readonly db: SisyphusDatabase
  /** The ceiling in force, read at admission from deploy-time configuration (FR-040). */
  readonly ceiling: number
  /** Provisioning (T052), called per admitted workflow after its transaction commits. */
  readonly starter?: WorkflowStarter
  /** Maximum admissions to attempt in one invocation. Defaults to {@link DEFAULT_DRAIN_LIMIT}. */
  readonly limit?: number
  /**
   * How long a run may wait for a credential before it is failed (FR-028). Defaults to
   * {@link DEFAULT_CREDENTIAL_WAIT_LIMIT_MS}.
   */
  readonly credentialWaitLimitMs?: number
  /** Injectable clock, so the wait limit is testable without waiting an hour. */
  readonly now?: () => Date
  /**
   * Tells the owner of a run this drain failed that it failed (FR-136). Optional: a drain with no
   * notifier still drains, and its failures to announce are reported rather than raised (FR-141).
   *
   * Nothing announces a run *entering* the wait, and that is deliberate — FR-079 keeps waiting,
   * cooling off and parking off the notification path entirely. `sisyphus-notify` maps
   * `awaiting_credential` to no event, and it must stay that way: a run that waits and then starts
   * has produced no outcome, and paging somebody about ordinary pool contention they cannot act on
   * would happen once per waiting run every time the pool filled up.
   */
  readonly notifier?: WorkflowNotifier
}

/** A workflow that was admitted but whose provisioning hand-off threw. */
export interface DrainStartFailure {
  readonly workflowId: string
  readonly error: Error
}

/** A run this drain looked at and left waiting for an agent credential (FR-024, FR-026). */
export interface DrainedWaiter {
  readonly workflowId: string
  /** When the wait began, not when this drain looked at it. */
  readonly since: Date
  readonly reason: WaitReason
}

/** A run this drain failed because its wait passed the configured limit (FR-028). */
export interface ExpiredCredentialWait {
  readonly workflowId: string
  /** How long it waited, in milliseconds — the figure FR-028 requires to be recorded. */
  readonly waitedMs: number
  /** The reason **as recomputed at expiry**, not as recorded when the wait began. */
  readonly reason: WaitReason
  /** The sentence written to `workflows.outcome_reason`. */
  readonly outcomeReason: string
}

export interface DrainQueueResult {
  /** Admitted by *this* drain, in admission order. Never includes a coalesced attempt. */
  readonly admitted: readonly AdmittedWorkflow[]
  /**
   * Runs this drain offered a seat to and could not give one — still waiting, deliberately.
   *
   * Reported rather than silently skipped: this is the visible form of the reachability rule, and
   * an operator reading a drain that admitted nothing wants to know whether it found nothing to do
   * or found work it could not serve.
   */
  readonly waiting: readonly DrainedWaiter[]
  /** Runs failed for waiting past the limit (FR-028). */
  readonly expired: readonly ExpiredCredentialWait[]
  /** Workflows still `queued` after the drain. */
  readonly remainingQueued: number
  /** Workflows still `awaiting_credential` after the drain. */
  readonly remainingAwaitingCredential: number
  /** The drain stopped because the ceiling was full rather than because the queue emptied. */
  readonly ceilingReached: boolean
  /**
   * Admitted, but the hand-off to provisioning failed. The lease stands and the workflow is
   * `provisioning`, which is precisely the state the FR-039 reconciler exists to resolve — losing
   * the failure here would leave a lease nobody knows to release.
   */
  readonly startFailures: readonly DrainStartFailure[]
  /**
   * Notifications the drain could not hand off, one per expiry it failed to announce (FR-141).
   *
   * Reported rather than raised, for the same reason `reconcile.ts` does it: a run correctly failed
   * and not announced is a failed run with a failed notification, and turning it into a failed
   * drain would have the platform retry a state change it has already made.
   */
  readonly notificationErrors: readonly Error[]
}

/** See `admit-workflow.ts`: `noUncheckedIndexedAccess` is off, so indexing needs an honest type. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/**
 * Candidate ids, oldest first, across **both** ways of waiting.
 *
 * Read outside any transaction and deliberately treated as a hint: by the time an admission gets
 * to a candidate it may have been cancelled or admitted by another drain, and `admitWorkflow`
 * says so rather than trusting this list.
 *
 * The order is `created_at` then id, and the id is a UUID v7 so the tie-break is itself
 * chronological. One order over both states is what makes FR-026's "longest-waiting" and FR-040's
 * "oldest first" the same sentence rather than two policies that have to be reconciled.
 */
const drainCandidates = async (db: SisyphusDatabase, limit: number): Promise<readonly string[]> => {
  const rows = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(inArray(workflows.state, [...ADMISSIBLE_STATES]))
    .orderBy(asc(workflows.createdAt), asc(workflows.id))
    .limit(limit)

  return rows.map((row) => row.id)
}

const countInState = async (db: SisyphusDatabase, state: Workflow['state']): Promise<number> => {
  const rows = await db.select({ value: count() }).from(workflows).where(eq(workflows.state, state))

  return firstRow(rows)?.value ?? 0
}

/** Runs currently waiting for a credential, oldest first. */
const waitingWorkflowIds = async (db: SisyphusDatabase): Promise<readonly string[]> => {
  const rows = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(eq(workflows.state, 'awaiting_credential'))
    .orderBy(asc(workflows.createdAt), asc(workflows.id))

  return rows.map((row) => row.id)
}

/** Whole seconds, for a sentence. Never `0s` for a wait that really happened. */
const seconds = (milliseconds: number): string =>
  `${String(Math.max(1, Math.round(milliseconds / 1000)))}s`

/**
 * Fail one run that has waited too long (FR-028).
 *
 * The row is locked and re-read inside the transaction, so a run granted a seat by a concurrent
 * drain in the same instant keeps it: the state will no longer be `awaiting_credential` and this
 * returns `undefined` rather than failing a run that is about to start. FR-064 allows exactly one
 * outcome in force, and the grant is the better one.
 *
 * Nothing is released. A waiting run holds no compute lease and no credential lease — that is what
 * the state means — so there is no cleanup here, only a verdict.
 */
const expireOneWait = async (options: {
  readonly db: SisyphusDatabase
  readonly workflowId: string
  readonly waitedMs: number
  readonly limitMs: number
}): Promise<ExpiredCredentialWait | undefined> => {
  const { db, waitedMs, workflowId } = options

  // Recomputed here rather than read off the entry the wait began with: an hour is long enough for
  // the pool to have changed, and this sentence is the one a person reads on a terminal run.
  const reason = await describeWaitReason(db, { workflowId })

  const outcomeReason =
    `No agent credential became available within ${seconds(options.limitMs)}; this run waited ` +
    `${seconds(waitedMs)} and was failed for credential exhaustion. ${reason.summary} ${reason.remedy}`

  return db.transaction(async (tx) => {
    const locked = firstRow(
      await tx
        .select({ state: workflows.state })
        .from(workflows)
        .where(eq(workflows.id, workflowId))
        .for('update'),
    )

    if (locked?.state !== 'awaiting_credential') {
      return undefined
    }

    await tx
      .update(workflows)
      .set({ state: 'failed', terminalOutcome: 'failed', outcomeReason })
      .where(eq(workflows.id, workflowId))

    await tx.insert(workflowEvents).values({
      workflowId,
      event: 'failed',
      actorType: 'control_plane',
      detail: {
        reason: outcomeReason,
        // The duration, as a number as well as in the sentence: FR-028 asks for it to be recorded,
        // and a figure only available inside English is a figure nothing can aggregate.
        waitedMs,
        waitLimitMs: options.limitMs,
        credentialWaitReason: reason.kind,
        configurationFault: reason.configurationFault,
        credentialGroups: reason.groups.map((group) => group.name),
      },
    })

    return { workflowId, waitedMs, reason, outcomeReason }
  })
}

/**
 * Fail every run whose wait has passed the limit (FR-028).
 *
 * A run in `awaiting_credential` with **no recorded wait** is left alone. That is a run whose wait
 * predates the timeline entry, or one seeded by hand; there is no evidence of when it began, and a
 * sweep with no evidence has no business failing anything — the same rule `reconcile.ts` applies to
 * a paused run with no `paused` entry.
 */
const expireCredentialWaits = async (options: {
  readonly db: SisyphusDatabase
  readonly now: Date
  readonly limitMs: number
}): Promise<readonly ExpiredCredentialWait[]> => {
  const expired: ExpiredCredentialWait[] = []

  for (const workflowId of await waitingWorkflowIds(options.db)) {
    const recorded = await latestCredentialWait(options.db, workflowId)

    if (recorded === undefined) {
      continue
    }

    const waitedMs = options.now.getTime() - recorded.since.getTime()

    if (waitedMs <= options.limitMs) {
      continue
    }

    const outcome = await expireOneWait({
      db: options.db,
      workflowId,
      waitedMs,
      limitMs: options.limitMs,
    })

    if (outcome !== undefined) {
      expired.push(outcome)
    }
  }

  return expired
}

/** One waiting outcome, as the result reports it. */
const waiterOf = (outcome: AwaitingCredential): DrainedWaiter => ({
  workflowId: outcome.workflowId,
  since: outcome.since,
  reason: outcome.reason,
})

/**
 * Admit as much waiting work as the ceiling and the pool allow, oldest first.
 *
 * @param options - The handle, the ceiling, the wait limit, and optionally the provisioning seam to
 *   hand each admitted workflow to.
 * @returns What was admitted, what is still waiting and why, what was failed for waiting too long,
 *   and whether the ceiling or the queue ended it.
 */
export const drainQueue = async (options: DrainQueueOptions): Promise<DrainQueueResult> => {
  const { ceiling, db, starter } = options
  const limit = options.limit ?? DEFAULT_DRAIN_LIMIT
  const now = (options.now ?? ((): Date => new Date()))()
  const credentialWaitLimitMs = options.credentialWaitLimitMs ?? DEFAULT_CREDENTIAL_WAIT_LIMIT_MS

  const admitted: AdmittedWorkflow[] = []
  const waiting: DrainedWaiter[] = []
  const startFailures: DrainStartFailure[] = []
  const notificationErrors: Error[] = []
  let ceilingReached = false

  /**
   * Announce one expiry, after its transaction has committed (FR-136, FR-141).
   *
   * Only expiries are announced. Entering the wait is not notifiable under FR-079 and
   * `notificationEventForState` maps `awaiting_credential` to no event, so this could not announce
   * one even if it were asked to.
   */
  const announceFailure = async (workflowId: string): Promise<void> => {
    const event = notificationEventForState('failed')

    if (options.notifier === undefined || event === undefined) {
      return
    }

    try {
      await options.notifier.workflowEvent({ workflowId, event, now })
    } catch (thrown) {
      notificationErrors.push(toError(thrown))
    }
  }

  // Before the ceiling pre-check, and independent of it: a full ceiling must not be able to
  // postpone FR-028 indefinitely, and an expiring run is not competing for a slot anyway.
  const expired = await expireCredentialWaits({ db, now, limitMs: credentialWaitLimitMs })

  for (const expiry of expired) {
    await announceFailure(expiry.workflowId)
  }

  const settled = async (): Promise<DrainQueueResult> => ({
    admitted,
    waiting,
    expired,
    remainingQueued: await countInState(db, 'queued'),
    remainingAwaitingCredential: await countInState(db, 'awaiting_credential'),
    ceilingReached,
    startFailures,
    notificationErrors,
  })

  // A cheap pre-check: at the ceiling there is nothing to attempt, and every attempt would take the
  // platform-wide admission lock only to read the same count. The authoritative check is still the
  // one inside each admitting transaction — this one is allowed to be stale.
  if ((await countLiveLeases(db)) >= ceiling) {
    ceilingReached = true
    return settled()
  }

  for (const workflowId of await drainCandidates(db, limit)) {
    const outcome = await admitWorkflow({ db, workflowId, ceiling })

    if (outcome.outcome === 'queued') {
      // The ceiling filled while this drain was running — every later candidate is behind this one,
      // so there is no point asking about them.
      ceilingReached = true
      break
    }

    if (outcome.outcome === 'awaiting_credential') {
      // **SC-017 lives on this line.** The pool this run can reach has nothing, which says nothing
      // at all about the pool the next candidate can reach: a `break` here would let one saturated
      // group stall every profile attached elsewhere, in arrival order, for as long as it stayed
      // full.
      waiting.push(waiterOf(outcome))
      continue
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

  return settled()
}

/** The drain wrapped in the uniform job envelope. */
export const runDrainQueue = (options: DrainQueueOptions): Promise<JobOutcome<DrainQueueResult>> =>
  runJob(DRAIN_QUEUE_JOB_NAME, () => drainQueue(options))
