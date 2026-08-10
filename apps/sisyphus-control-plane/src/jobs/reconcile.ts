import { PAUSE_IDLE_CEILING_MS } from '@bluetel-ai/sisyphus-api/contracts'
import type { AgentCredential, SisyphusDatabase, Workflow } from '@bluetel-ai/sisyphus-api/db'
import {
  agentCredentials,
  computeLeases,
  credentialLeases,
  sessionSnapshots,
  workflowEvents,
  workflows,
} from '@bluetel-ai/sisyphus-api/db'
import type { WorkflowNotifier } from '@bluetel-ai/sisyphus-notify'
import { notificationEventForState } from '@bluetel-ai/sisyphus-notify'
import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm'

import type { ComputeProvisioner } from '../aws'
import { revokeScopedCredentials } from '../credentials'
import { returnFromCoolingOff } from '../credentials/health'
import { releaseLease as releaseAgentCredentialLease } from '../credentials/lease'

import {
  AGENT_CREDENTIAL_RETAINING_OUTCOME,
  isTerminalWorkflowState,
  releasesAgentCredential,
} from './agent-credential-release'
import { parseInstanceTag } from './instance-tag'
import type { JobOutcome } from './run-job'
import { runJob, toError } from './run-job'
import type { QueueDrain } from './teardown-workflow'

/**
 * Reconciliation (T067, FR-039) — reality against recorded state, **in both directions**.
 *
 * The two directions fail differently, which is why FR-039 names them separately and why doing
 * only one is not half a reconciler.
 *
 * **A lease with no live workflow costs money silently.** Nothing surfaces it: the run shows as
 * finished, the panel is calm, and an instance keeps billing until somebody reads an invoice. It
 * is the only failure in the platform with no symptom other than cost, and SC-007's "zero orphans
 * over a 30-day window" is the assertion that it does not happen.
 *
 * **A workflow whose compute has vanished hangs for ever.** The run says `running`, the instance is
 * gone — reclaimed spot capacity, a kernel panic, a terminate somebody issued by hand — and the
 * executor that would have called `reportTerminal` died before it could (FR-056 names this
 * reconciler as the backstop). Without this direction the workflow stays non-terminal indefinitely,
 * which SC-006 forbids and which makes a user wait for something that will never arrive.
 *
 * ## Why the destination is `parked_resumable` or `failed` rather than always `failed`
 *
 * A run with a resumable snapshot has its work intact — both state flags set, per FR-050 — so
 * failing it would throw away recoverable work and put SC-008's 95% interruption recovery out of
 * reach. A run without one has nothing to resume from and `parked_resumable` would promise a
 * resume that cannot happen. So the snapshot decides, and **the reason is always recorded**: on
 * `outcome_reason` and on the timeline, attributed to `reconciler`, because "your run failed" with
 * no reason is indistinguishable from a platform bug.
 *
 * ## The third thing a sweep is looking for: a pause nobody came back to (T181, FR-049, US2 §4)
 *
 * A paused run is in {@link ACTIVE_STATES} because a pause **holds its instance** — that is the
 * difference between pausing and parking, and it is the whole reason pausing is useful. It is also
 * why a pause cannot be allowed to last for ever: an instance held for a person who never came back
 * is the same silent cost as a leaked lease, arriving by a different route and looking, to every
 * check above, perfectly healthy. Its heartbeat is current, its instance is running, and its lease
 * is live, because all of that is true.
 *
 * So a paused run is also judged against the clock. Past {@link PAUSE_IDLE_CEILING_MS} plus
 * {@link PAUSE_IDLE_GRACE_MS} it is moved out — to `parked_resumable`, because FR-049 registers a
 * snapshot before a pause is ever acknowledged, so a paused run is a resumable run by
 * construction — its lease is released in the same pass, and the owner is told it was **parked**
 * rather than failed.
 *
 * **Where `paused_at` comes from.** There is no such column, and this does not add one. The
 * timeline already carries the fact: `acknowledgeSupervisionCommand` writes a `paused` row into
 * `workflow_events` in the same transaction that moves the state, exactly once per pause. The most
 * recent one is when the current pause began — "most recent" rather than "the one", because a run
 * may be paused, resumed and paused again, and the state being `paused` now is what makes the
 * latest `paused` row the live one. A second column holding the same fact would be a second thing
 * to keep in step, and the interesting failure of such pairs is that they disagree.
 *
 * **A paused run with no `paused` row is left alone.** That is a run whose pause predates the
 * timeline entry, or one seeded by hand; the sweep has no evidence of when it began and so has no
 * business acting, which is the same rule the checks below apply to a missing heartbeat.
 *
 * ## The thing this must not do
 *
 * A reconciler that kills healthy runs is worse than one that leaks. Three cases look like death
 * and are not:
 *
 * - a run **mid-provision**, whose lease exists and whose instance is booting. It has no heartbeat
 *   yet, and will not for several minutes;
 * - a run whose lease has **no `provider_instance_id` yet** — admission took the lease, the launch
 *   has not returned. Its instance is genuinely absent from the sweep and must not be read as gone;
 * - a **bundle validation run**, whose instance carries a tag that resolves to no workflow at all
 *   (FR-147). Looked up naively it is indistinguishable from a leak — see `instance-tag.ts`.
 *
 * So absence of a heartbeat is only evidence after {@link PROVISIONING_GRACE_MS}, absence of an
 * instance is only evidence once one was recorded, and the tag is parsed rather than assumed.
 *
 * ## Telling the owner (T177, FR-136, FR-141)
 *
 * This is the one job in the control plane that puts a run into a state FR-136 names — `failed`, or
 * `parked_resumable` — and it is therefore the one that has to announce it. The owner of a run
 * whose instance vanished learns nothing from the panel unless they happen to be looking at it, and
 * SC-034 gives them two minutes.
 *
 * The notification is emitted **after** `moveWorkflow`'s transaction has committed, never inside
 * it: a Slack round trip inside a row lock would hold the lock for the duration of a network call,
 * and a failure inside it would roll back a state change that has already been decided. It is also
 * wrapped, and its failures are collected into {@link ReconcileResult.notificationErrors} rather
 * than raised — FR-141 makes a run that could not be announced a swept run with a failed
 * notification, not a failed sweep. The `notifier` is optional so a caller that has not wired one
 * still reconciles; announcing is not the sweep's purpose.
 *
 * ## The fourth thing: a seat in the agent-credential pool nobody is left to hand back (003/FR-022)
 *
 * The FR-039 sweep gains one direction, and it is the same argument as the first with a scarcer
 * resource. A compute lease outliving its run costs money silently; an **agent credential** lease
 * outliving its run costs the platform one of a small number of identities, and it does so just as
 * silently — the run shows as finished, the pool view shows a seat held by something, and the next
 * workflow that asks for one waits for a seat nobody is using. SC-015 is the assertion that this
 * does not become permanent: every lease whose workflow has ceased to exist is released within one
 * reconciliation interval.
 *
 * It is released with `release_reason = 'forced'` and `released_by_user_id` **null**, and that null
 * is the attribution. FR-057 has an administrator's force-release recorded against the
 * administrator; this is the platform tidying up after a run that no longer exists, and the audit
 * entry `releaseLease` writes carries a null actor precisely so the two can be told apart (FR-058,
 * SC-015). Attributing a sweep to a person would be worse than not attributing it at all.
 *
 * **It does not touch a seat held by a `paused` or `parked_resumable` run.** Those are live claims
 * by design — a pause holds its instance and a park holds its identity so FR-151 can resume onto
 * it — and this sentence is the bug it exists to prevent, because both look finished from here:
 * `parked_resumable` is a terminal outcome, so every other terminal check in this file answers true
 * for it. `releasesAgentCredential` in `agent-credential-release.ts` is the one place that rule
 * lives, and the sweep consults it rather than restating it. Nor does it touch a seat held by a run
 * in any live state, `awaiting_credential` included: a seat just granted to a waiter is a lease
 * whose workflow is not yet `provisioning`, and a sweep reading that as "not running" would take
 * back the grant it had come to make possible.
 *
 * **Except when a parked run's snapshot passes its retention period** (T104, 003/FR-073). FR-073 is
 * two clauses and the second is the one with a deadline in it: *"a parked workflow MUST retain its
 * agent credential, and MUST release it when it becomes terminal — including when it becomes
 * terminal by its durable snapshot passing the retention period and ceasing to be resumable"*. A
 * park holds a seat on behalf of a resume; `session_snapshots.expires_at` is the date that resume
 * stops being possible; and after it the run is holding one of a small number of agent identities
 * for something that can never happen. Nothing else would ever notice — the run is already
 * terminal, so no state change is coming, no executor is left to report anything, and the pool view
 * would go on showing a `parked` holder indefinitely. This sweep is the only thing looking.
 *
 * It releases the seat and **leaves the run's state exactly where it is**. `parked_resumable` is
 * already the outcome in force, FR-064 allows one, and rewriting it to `failed` would recast a run
 * that parked in an orderly way as one that broke. What changed is not the run: it is that the
 * platform has stopped keeping the option open.
 *
 * ## The fifth thing: a seat cooling off that nobody will ever return (003/FR-076, FR-078)
 *
 * `cooling_off` is the one credential state that is **supposed** to end without anybody doing
 * anything. A provider refused on a usage or rate limit, the credential is alive, and it comes back
 * when the limit clears — SC-019 states that as "returns to service without any administrator
 * action, and generates no alert". Something has to be the thing that returns it, and this is that
 * thing.
 *
 * Two populations, and the second is the one that would otherwise be lost for ever:
 *
 * 1. **Past its `cooling_off_until`.** The provider named a reset time, the time has passed, the
 *    seat goes back in the pool.
 * 2. **No `cooling_off_until` at all**, and last changed longer ago than
 *    {@link COOLING_OFF_RETRY_MS}. Plenty of providers refuse a quota without saying when it
 *    clears, and a null read as "wait until told" is a seat that never comes back — the exact
 *    failure FR-078 exists to forbid ("where it does not, the credential MUST still be retried
 *    rather than left cooling off indefinitely").
 *
 * **The clock for the second population is `updated_at`**, and that is a compromise worth naming.
 * There is no `cooling_off_since` column and this does not add one: the row's own `updated_at` is
 * written by the transition that put it into `cooling_off`, so it is the entry time in every
 * ordinary case. It is not *only* written by that — any later update to the row moves it, which
 * would postpone a retry — and the alternative, writing a deadline of our own invention into
 * `cooling_off_until`, is worse: that column is rendered to administrators as the provider's
 * expected return time (FR-078), and filling it with a guess would put an invention on a screen.
 * Delaying a retry by one interval is recoverable; a made-up return time is not.
 *
 * Returning a seat is not a repair, and the sweep asserts nothing about the credential's health: it
 * goes back to `available` and the next workflow to draw it finds out whether the limit really has
 * cleared. If it has not, the next refusal puts it straight back — which is the same self-correcting
 * loop FR-076 describes, running one workflow slower.
 *
 * ## Order within one pass
 *
 * Workflows are moved first, then leases are swept, then instances, then agent-credential seats,
 * then cooling-off seats. That way a run this pass has just declared dead has its lease released
 * and its instance destroyed in the same pass, rather than waiting for the next one — which is what
 * keeps a lapsed run inside SC-007's ten minutes. Seats come after that for the same reason and one
 * more: a run moved to `parked_resumable` by the pause-idle check above must keep its seat, and it
 * can only be judged against the state this pass left it in. Cooling-off returns come last because
 * they are the only step that *adds* capacity, and the drain at the bottom of the pass is what puts
 * that capacity in front of the queue immediately rather than a tick later (FR-076, T065).
 */

export const RECONCILE_JOB_NAME = 'reconcile'

/**
 * How long a run may go without a heartbeat before it is treated as gone.
 *
 * FR-048 has the executor sending a heartbeat at a defined interval; this is several intervals of slack,
 * because a single missed beat is a network blip and declaring a run dead over one would be the
 * expensive mistake in the other direction.
 */
export const HEARTBEAT_LAPSE_MS = 5 * 60 * 1000

/**
 * How long a run that has never sent a heartbeat is given before it counts as failed to start.
 *
 * Generous on purpose. Bootstrap phases 2–5 run before the executor is in a position to say
 * anything — a bundle download, a digest check, an unpack and a `setup.sh` that may be installing
 * a toolchain — and cutting that short destroys an instance that was working.
 */
export const PROVISIONING_GRACE_MS = 20 * 60 * 1000

/**
 * How long a paused run may sit untouched before its instance is handed back (FR-049, US2 §4).
 *
 * The same thirty minutes the executor counts in `session/idle-ceiling.ts`, and the reasoning for
 * the number lives there. It is now **one** value rather than a copy: it comes from
 * `@bluetel-ai/sisyphus-api/contracts`, which is the shared home the previous comment here said the
 * threshold belonged in, and is re-exported so that this file stays the place a reconcile reader
 * looks for it.
 *
 * The two enforcers are still not doing the same job — the executor's timer is the one that
 * normally fires and this is the backstop for the case where it could not — which is what
 * {@link PAUSE_IDLE_GRACE_MS} below expresses. A backstop working to a *different limit* from the
 * thing it backs up would have been two behaviours wearing one name; a backstop working to the same
 * limit plus a stated margin is a backstop.
 */
export { PAUSE_IDLE_CEILING_MS }

/**
 * How much longer than the ceiling the reconciler waits before acting on a paused run.
 *
 * The instance is meant to hand itself back at the ceiling; this sweep exists for the instance that
 * did not — because it crashed, hung, or had its capacity reclaimed before the timer fired. The
 * grace is what keeps the two from racing: without it, a sweep landing in the same second as the
 * executor's timer would move the run while the executor was reporting its own outcome, and one of
 * the two would be writing over the other's account of how the run ended.
 */
export const PAUSE_IDLE_GRACE_MS = 5 * 60 * 1000

/**
 * States in which a workflow may still be holding compute. A lease outliving one of these leaks.
 *
 * **`awaiting_credential` is deliberately not a member, and neither is `queued`** (003/FR-024,
 * FR-025). The list is not "states a run is alive in" — `ACTIVE_WORKFLOW_STATES` in
 * `sisyphus-api/src/enums` is that list, and a waiting run *is* a member of it, because the seat
 * sweep at the bottom of this file must go on treating it as live. This list is narrower and is
 * used for one thing: direction two, which reads "no live compute lease" as evidence that a run's
 * instance has gone away.
 *
 * A waiting run has no compute lease **by construction** — that is the whole point of the state,
 * and SC-004 measures it — so adding it here would make the very first check below fire on every
 * waiter, every pass, and move it to `failed` with "the instance it was working on is gone" for an
 * instance it was never given. The FR-028 limit is what ends a wait that has gone on too long, and
 * it lives in `drain-queue.ts` where the clock and the reason are.
 */
const ACTIVE_STATES = ['provisioning', 'running', 'paused'] as const

/**
 * How long a credential cooling off with **no stated return time** waits before it is retried
 * (003/FR-078).
 *
 * The default matches `SISYPHUS_COOLING_OFF_RETRY_MINUTES`, which is where a deployment sets it;
 * this constant is the value in force when nothing passes one, so the sweep behaves the same in a
 * test as in a deployment that has not overridden it. Fifteen minutes is a guess and is documented
 * as one in `env-schemas.ts` — the cadence is ours to choose precisely because the provider named
 * nothing, and research R1 leaves it unmeasured.
 *
 * It does **not** apply to a credential whose `cooling_off_until` the provider did state. That one
 * is returned when the provider said, not when this constant says.
 *
 * Written as minutes times `60_000` rather than in the more conventional three-factor form on
 * purpose: `no-restated-claims.test.ts` forbids that exact spelling anywhere in this application,
 * because it is how the machine credential's own fifteen-minute window would be written out a
 * second time. Two unrelated quantities that happen to share a number are precisely the case a
 * textual check cannot tell apart, and spelling this one differently is cheaper than teaching it to.
 */
export const COOLING_OFF_RETRY_MS = 15 * 60_000

export interface ReconcileOptions {
  readonly db: SisyphusDatabase
  readonly compute: ComputeProvisioner
  /** Injectable clock, so the thresholds are testable without waiting. */
  readonly now?: () => Date
  readonly heartbeatLapseMs?: number
  readonly provisioningGraceMs?: number
  readonly pauseIdleCeilingMs?: number
  readonly pauseIdleGraceMs?: number
  /**
   * `SISYPHUS_COOLING_OFF_RETRY_MINUTES`, in milliseconds (003/FR-078).
   *
   * Passed in rather than read here, the same rule every other threshold in this file follows: jobs
   * do not read their own configuration, so a test can state the value under test and the
   * composition root is the only place an environment variable is converted.
   */
  readonly coolingOffRetryMs?: number
  /** Run once at the end if anything was released, for the same reason teardown runs it. */
  readonly queueDrain?: QueueDrain
  /**
   * Tells the run's owner it was swept (FR-136). Optional: a sweep with no notifier still sweeps.
   *
   * See the module comment for why this is a seam rather than a Slack client, and why its failures
   * are reported rather than raised.
   */
  readonly notifier?: WorkflowNotifier
}

/** A workflow the sweep moved out of a non-terminal state, and why. */
export interface MovedWorkflow {
  readonly workflowId: string
  readonly from: Workflow['state']
  readonly to: 'failed' | 'parked_resumable'
  readonly reason: string
}

/** A lease the sweep released because its run was over. */
export interface ReleasedLease {
  readonly leaseId: string
  readonly workflowId: string
  readonly instanceId: string | undefined
  readonly reason: string
}

/** An instance the sweep destroyed. */
export interface TerminatedInstance {
  readonly instanceId: string
  readonly workflowId: string | undefined
  readonly reason: string
}

/** A seat in the agent-credential pool the sweep took back (FR-022, SC-015). */
export interface ReleasedCredentialSeat {
  readonly leaseId: string
  readonly workflowId: string
  readonly agentCredentialId: string
  /** The run's state when the sweep judged it, or `undefined` when there was no run left. */
  readonly workflowState: Workflow['state'] | undefined
  /**
   * Where the credential ended up.
   *
   * `available` in the ordinary case, and whatever it already was if it had become `cooling_off` or
   * `unhealthy` while held — release does not repair (FR-033). Reported because it is the
   * surprising one: a sweep that freed a seat which did **not** return to the pool has not added
   * any capacity, and an administrator reading "released" alone would conclude that it had.
   */
  readonly credentialState: AgentCredential['state']
  readonly reason: string
}

/** A credential the sweep put back in the pool because its limit had cleared (FR-076, FR-078). */
export interface ReturnedCredential {
  readonly agentCredentialId: string
  /**
   * Which of FR-078's two cases returned it.
   *
   * `stated` is the provider's own reset time having passed. `unstated` is the credential the
   * provider refused without naming a time, retried on the configured interval — the population
   * that would otherwise cool off for ever, and the one worth being able to count separately when
   * asking whether the interval is right.
   */
  readonly returnedBecause: 'stated' | 'unstated'
  /**
   * Where it actually went.
   *
   * `available` in the ordinary case, and `held` when a run was waiting the limit out on this very
   * seat (FR-077): that credential is still the run's, and returning it to the pool would put one
   * agent identity in front of a second workflow. Reported because it is the distinction an
   * administrator counting recovered capacity has to make — a `held` return added no capacity at
   * all, it just let a waiting run carry on.
   */
  readonly returnedTo: string
  readonly reason: string
}

export interface ReconcileResult {
  /** Direction two: workflows whose compute vanished or fell silent. */
  readonly moved: readonly MovedWorkflow[]
  /** Direction one: leases outliving their run. */
  readonly released: readonly ReleasedLease[]
  /** Direction one: instances nothing holds a lease for. */
  readonly terminated: readonly TerminatedInstance[]
  /** Direction one, for the scarcer resource: seats outliving the run that reserved them. */
  readonly releasedSeats: readonly ReleasedCredentialSeat[]
  /** The only step that adds capacity: cooling-off seats whose limit has cleared (FR-076). */
  readonly returnedToPool: readonly ReturnedCredential[]
  /** Validation instances seen and deliberately left alone (FR-147). */
  readonly validationInstances: readonly string[]
  /** Non-terminal runs the sweep looked at and left running. */
  readonly healthy: number
  readonly queueDrainError: Error | undefined
  /**
   * Notifications the sweep could not hand off, one per move it failed to announce (FR-141).
   *
   * Reported rather than raised. A run that was correctly swept and could not be announced is a
   * swept run with a failed notification; turning it into a failed sweep would have the reconciler
   * retry a move it has already made, every minute, for as long as Slack is unreachable.
   */
  readonly notificationErrors: readonly Error[]
}

/** See `admit-workflow.ts`: `noUncheckedIndexedAccess` is off, so indexing needs an honest type. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/**
 * Whether the run has something to resume from.
 *
 * Both state flags, per FR-050: conversation state without the worktree restores an agent whose
 * filesystem beliefs are wrong, and the worktree without the conversation restores a tree nobody
 * can explain. A snapshot missing either is not resumable, so a run holding one is `failed`, not
 * `parked_resumable` — promising a resume that cannot happen is worse than saying it failed.
 */
const hasResumableSnapshot = async (db: SisyphusDatabase, workflowId: string): Promise<boolean> =>
  firstRow(
    await db
      .select({ id: sessionSnapshots.id })
      .from(sessionSnapshots)
      .where(
        and(
          eq(sessionSnapshots.workflowId, workflowId),
          eq(sessionSnapshots.isCurrent, true),
          eq(sessionSnapshots.hasConversationState, true),
          eq(sessionSnapshots.hasWorktreeState, true),
        ),
      )
      .limit(1),
  ) !== undefined

/**
 * Move one workflow out of a non-terminal state, recording the reason.
 *
 * The row is locked and re-read inside the transaction, so a `reportTerminal` that landed while
 * this pass was deciding wins: FR-064 allows exactly one outcome in force, and the executor's own
 * account of how the run ended is better than the reconciler's inference. `undefined` is returned
 * when the run turned out to be terminal already.
 */
const moveWorkflow = async (options: {
  readonly db: SisyphusDatabase
  readonly workflowId: string
  readonly reason: string
  readonly now: Date
}): Promise<MovedWorkflow | undefined> => {
  const { db, reason, workflowId } = options
  const to = (await hasResumableSnapshot(db, workflowId)) ? 'parked_resumable' : 'failed'

  return db.transaction(async (tx) => {
    const locked = firstRow(
      await tx
        .select({ state: workflows.state })
        .from(workflows)
        .where(eq(workflows.id, workflowId))
        .for('update'),
    )

    if (locked === undefined || isTerminalWorkflowState(locked.state)) {
      return undefined
    }

    await tx
      .update(workflows)
      .set({ state: to, terminalOutcome: to, outcomeReason: reason })
      .where(eq(workflows.id, workflowId))

    await tx.insert(workflowEvents).values({
      workflowId,
      event: to === 'parked_resumable' ? 'parked' : 'failed',
      actorType: 'reconciler',
      detail: { reason, from: locked.state },
    })

    return { workflowId, from: locked.state, to, reason }
  })
}

/** Release one lease, destroy its instance and revoke the run's credential. */
const releaseLease = async (options: {
  readonly db: SisyphusDatabase
  readonly compute: ComputeProvisioner
  readonly leaseId: string
  readonly workflowId: string
  readonly instanceId: string | null
  readonly reason: string
  readonly now: Date
}): Promise<ReleasedLease> => {
  if (options.instanceId !== null) {
    await options.compute.terminate({ instanceId: options.instanceId })
  }

  await options.db
    .update(computeLeases)
    .set({ releasedAt: options.now, releaseReason: options.reason })
    .where(and(eq(computeLeases.id, options.leaseId), isNull(computeLeases.releasedAt)))

  await revokeScopedCredentials({
    db: options.db,
    workflowId: options.workflowId,
    now: options.now,
  })

  return {
    leaseId: options.leaseId,
    workflowId: options.workflowId,
    instanceId: options.instanceId ?? undefined,
    reason: options.reason,
  }
}

/**
 * When each of these runs was last paused, from the timeline.
 *
 * See the module comment for why this is `workflow_events` rather than a `workflows.paused_at`
 * column. A workflow absent from the answer has no `paused` row and is deliberately left alone.
 *
 * @param db - The handle.
 * @param workflowIds - The runs currently in state `paused`.
 */
const pauseBeganAt = async (
  db: SisyphusDatabase,
  workflowIds: readonly string[],
): Promise<Map<string, Date>> => {
  if (workflowIds.length === 0) {
    return new Map()
  }

  const rows = await db
    .select({ workflowId: workflowEvents.workflowId, createdAt: workflowEvents.createdAt })
    .from(workflowEvents)
    .where(
      and(inArray(workflowEvents.workflowId, [...workflowIds]), eq(workflowEvents.event, 'paused')),
    )

  const latest = new Map<string, Date>()

  for (const row of rows) {
    const seen = latest.get(row.workflowId)

    // Latest wins: a run may have been paused, resumed and paused again, and it is the current
    // pause the ceiling is about.
    if (seen === undefined || row.createdAt.getTime() > seen.getTime()) {
      latest.set(row.workflowId, row.createdAt)
    }
  }

  return latest
}

/** Every live lease, with the state of the run holding it. */
const liveLeases = async (db: SisyphusDatabase) =>
  db
    .select({
      leaseId: computeLeases.id,
      workflowId: computeLeases.workflowId,
      providerInstanceId: computeLeases.providerInstanceId,
      requestedAt: computeLeases.requestedAt,
      lastHeartbeatAt: computeLeases.lastHeartbeatAt,
      state: workflows.state,
    })
    .from(computeLeases)
    .innerJoin(workflows, eq(workflows.id, computeLeases.workflowId))
    .where(isNull(computeLeases.releasedAt))

/**
 * Every live agent-credential lease, with the state of the run holding it — or nothing, where the
 * run is gone.
 *
 * A **left** join, and that is the half of SC-015 that reads oddly today: `credential_leases`
 * carries a foreign key to `workflows` with no cascade, so a workflow holding a live lease cannot
 * currently be deleted at all and the null branch is unreachable. It is written this way anyway
 * because SC-015 is phrased over leases whose workflow "has ceased to exist", and a sweep that
 * inner-joined would answer that requirement by silently not looking — the failure mode where the
 * guarantee holds only for as long as an unrelated constraint elsewhere does.
 */
const liveCredentialSeats = async (db: SisyphusDatabase) =>
  db
    .select({
      leaseId: credentialLeases.id,
      workflowId: credentialLeases.workflowId,
      agentCredentialId: credentialLeases.agentCredentialId,
      state: workflows.state,
    })
    .from(credentialLeases)
    .leftJoin(workflows, eq(workflows.id, credentialLeases.workflowId))
    .where(isNull(credentialLeases.releasedAt))

/**
 * Parked runs whose durable snapshot has passed its retention period (003/FR-073).
 *
 * The join is to `workflows.current_snapshot_id` rather than to every snapshot the run ever took,
 * because that column is what a resume would actually be rebuilt from — an older archive still
 * inside its retention says nothing about whether *this* run can come back.
 *
 * A parked run with **no** current snapshot is deliberately absent from the answer, and that is the
 * same rule the pause-idle check applies to a run with no `paused` row: expiry is a fact this sweep
 * has to be able to point at, and a null read as "expired" would take the seat off every parked run
 * whose snapshot row this database has not seen — including, in a test fixture or a half-migrated
 * deployment, ones whose work is perfectly intact.
 *
 * @param db - The handle.
 * @param now - The pass's clock.
 * @returns Workflow id to the instant its snapshot stopped being retained.
 */
const parkedBeyondSnapshotRetention = async (
  db: SisyphusDatabase,
  now: Date,
): Promise<Map<string, Date>> => {
  const rows = await db
    .select({ workflowId: workflows.id, expiresAt: sessionSnapshots.expiresAt })
    .from(workflows)
    .innerJoin(sessionSnapshots, eq(sessionSnapshots.id, workflows.currentSnapshotId))
    .where(
      and(
        eq(workflows.state, AGENT_CREDENTIAL_RETAINING_OUTCOME),
        lte(sessionSnapshots.expiresAt, now),
      ),
    )

  return new Map(rows.map((row) => [row.workflowId, row.expiresAt]))
}

/**
 * Cooling-off credentials whose limit has, one way or the other, run out (FR-076, FR-078).
 *
 * Both populations in one query, so a pass makes one round trip rather than two and so the two
 * cases cannot come to disagree about what "elapsed" means. The partial index
 * `agent_credentials_cooling_off_idx` serves it: the set is by design tiny, and the index is
 * partial for exactly that reason.
 *
 * `updated_at` is the clock for the unstated case. See the module note for why that is a compromise
 * and why the alternative — inventing a `cooling_off_until` — is the worse one.
 */
const coolingOffCredentials = async (
  db: SisyphusDatabase,
  now: Date,
  retryMs: number,
): Promise<readonly { id: string; coolingOffUntil: Date | null }[]> =>
  db
    .select({
      id: agentCredentials.id,
      coolingOffUntil: agentCredentials.coolingOffUntil,
    })
    .from(agentCredentials)
    .where(
      and(
        eq(agentCredentials.state, 'cooling_off'),
        or(
          lte(agentCredentials.coolingOffUntil, now),
          and(
            isNull(agentCredentials.coolingOffUntil),
            lte(agentCredentials.updatedAt, new Date(now.getTime() - retryMs)),
          ),
        ),
      ),
    )

/**
 * Sweep both directions once.
 *
 * @param options - The handle, the compute seam, and the thresholds in force.
 * @returns What moved, what was released, what was destroyed, and how much was left alone.
 */
export const reconcile = async (options: ReconcileOptions): Promise<ReconcileResult> => {
  const { compute, db } = options
  const now = (options.now ?? ((): Date => new Date()))()
  const heartbeatLapseMs = options.heartbeatLapseMs ?? HEARTBEAT_LAPSE_MS
  const provisioningGraceMs = options.provisioningGraceMs ?? PROVISIONING_GRACE_MS
  const pauseIdleCeilingMs = options.pauseIdleCeilingMs ?? PAUSE_IDLE_CEILING_MS
  const pauseIdleGraceMs = options.pauseIdleGraceMs ?? PAUSE_IDLE_GRACE_MS
  const coolingOffRetryMs = options.coolingOffRetryMs ?? COOLING_OFF_RETRY_MS

  const instances = await compute.listWorkflowInstances()
  const liveInstanceIds = new Set(instances.map((instance) => instance.instanceId))

  const leases = await liveLeases(db)
  const leaseByWorkflow = new Map(leases.map((lease) => [lease.workflowId, lease]))

  // --- Direction two: a workflow whose lease vanished or whose heartbeat lapsed ----------------

  const activeWorkflows = await db
    .select({ id: workflows.id, state: workflows.state })
    .from(workflows)
    .where(inArray(workflows.state, [...ACTIVE_STATES]))

  const pausedSince = await pauseBeganAt(
    db,
    activeWorkflows
      .filter((workflow) => workflow.state === 'paused')
      .map((workflow) => workflow.id),
  )

  const moved: MovedWorkflow[] = []
  const notificationErrors: Error[] = []
  let healthy = 0

  /**
   * Announce one move, after its transaction has committed and outside anything that could fail
   * because of it (FR-136, FR-141).
   */
  const announce = async (move: MovedWorkflow): Promise<void> => {
    const event = notificationEventForState(move.to)
    if (options.notifier === undefined || event === undefined) {
      return
    }

    try {
      await options.notifier.workflowEvent({ workflowId: move.workflowId, event, now })
    } catch (thrown) {
      notificationErrors.push(toError(thrown))
    }
  }

  /**
   * A pause nobody came back to (FR-049, US2 §4).
   *
   * Checked **after** the evidence above and never instead of it: a paused run whose instance has
   * vanished is a vanished instance, and reporting it as an expired pause would tell the owner
   * their run was parked in an orderly way when in fact the machine went away underneath it.
   */
  const idleCeilingReason = (workflow: {
    readonly id: string
    readonly state: string
  }): string | undefined => {
    if (workflow.state !== 'paused') {
      return undefined
    }

    const began = pausedSince.get(workflow.id)

    if (began === undefined) {
      return undefined
    }

    const idleFor = now.getTime() - began.getTime()

    return idleFor > pauseIdleCeilingMs + pauseIdleGraceMs
      ? `paused and untouched for ${String(Math.round(idleFor / 1000))}s, beyond the ` +
          `${String(Math.round(pauseIdleCeilingMs / 1000))}s pause idle ceiling and its ` +
          `${String(Math.round(pauseIdleGraceMs / 1000))}s grace. The instance was released and ` +
          'the run parked rather than failed: the pause registered a snapshot before it was ' +
          'acknowledged, so resuming continues from there'
      : undefined
  }

  for (const workflow of activeWorkflows) {
    const lease = leaseByWorkflow.get(workflow.id)
    const reason = ((): string | undefined => {
      if (lease === undefined) {
        return 'the run holds no live compute lease, so the instance it was working on is gone'
      }

      if (lease.providerInstanceId !== null && !liveInstanceIds.has(lease.providerInstanceId)) {
        return `instance ${lease.providerInstanceId} is no longer running`
      }

      if (lease.lastHeartbeatAt !== null) {
        const silentFor = now.getTime() - lease.lastHeartbeatAt.getTime()
        return silentFor > heartbeatLapseMs
          ? `no heartbeat for ${String(Math.round(silentFor / 1000))}s, beyond the ${String(Math.round(heartbeatLapseMs / 1000))}s threshold`
          : undefined
      }

      // No heartbeat yet. That is ordinary for minutes: bootstrap phases 2–5 run before the
      // executor can say anything, and `setup.sh` may be installing a toolchain.
      const provisioningFor = now.getTime() - lease.requestedAt.getTime()
      return provisioningFor > provisioningGraceMs
        ? `no heartbeat within ${String(Math.round(provisioningGraceMs / 1000))}s of the lease being taken, so the instance never came up`
        : undefined
    })()
    // Only for a run that survived every check above: a healthy paused run is still a run holding
    // an instance, and the clock is the one thing left that can say it should not be.
    const evidence = reason ?? idleCeilingReason(workflow)

    if (evidence === undefined) {
      healthy += 1
      continue
    }

    const move = await moveWorkflow({ db, workflowId: workflow.id, reason: evidence, now })
    if (move !== undefined) {
      moved.push(move)
      await announce(move)
    }
  }

  // --- Direction one: a lease with no live workflow --------------------------------------------
  //
  // Re-read, so the runs direction two just moved are swept in this pass rather than the next —
  // which is what keeps a lapsed run inside SC-007's ten minutes.

  const released: ReleasedLease[] = []
  const terminated: TerminatedInstance[] = []
  const destroyed = new Set<string>()

  for (const lease of await liveLeases(db)) {
    if (!isTerminalWorkflowState(lease.state)) {
      continue
    }

    released.push(
      await releaseLease({
        db,
        compute,
        leaseId: lease.leaseId,
        workflowId: lease.workflowId,
        instanceId: lease.providerInstanceId,
        reason: `workflow is ${lease.state}; lease outlived the run`,
        now,
      }),
    )

    if (lease.providerInstanceId !== null) {
      destroyed.add(lease.providerInstanceId)
    }
  }

  // --- Direction one, continued: instances the database holds no live lease for -----------------

  const heldInstanceIds = new Set(
    (await liveLeases(db)).flatMap((lease) =>
      lease.providerInstanceId === null ? [] : [lease.providerInstanceId],
    ),
  )
  const validationInstances: string[] = []

  for (const instance of instances) {
    if (destroyed.has(instance.instanceId) || heldInstanceIds.has(instance.instanceId)) {
      continue
    }

    const tag = parseInstanceTag(instance.workflowId)

    if (tag.kind === 'validation') {
      // Not a leak, and not this job's to end. A validation run holds no lease by construction —
      // `compute_leases.workflow_id` is `not null` and it has no workflow — so judging it by the
      // lease table would destroy a healthy instance halfway through `setup.sh`.
      validationInstances.push(instance.instanceId)
      continue
    }

    const reason =
      tag.kind === 'unattributed'
        ? 'the instance carries the platform tag with no run behind it'
        : `no live compute lease records instance ${instance.instanceId} for workflow ${tag.id}`

    await compute.terminate({ instanceId: instance.instanceId })
    terminated.push({ instanceId: instance.instanceId, workflowId: tag.id, reason })
  }

  // --- Direction one, for the scarcer resource: a seat outliving its run (FR-022, SC-015) -------
  //
  // Last in the pass, and re-read, so that a run this pass moved is judged on the state this pass
  // left it in — a run parked by the pause-idle check above keeps its seat, and a run failed by any
  // of the checks above gives one back in the same interval rather than the next.

  const releasedSeats: ReleasedCredentialSeat[] = []
  // The one way a parked run's seat comes back (FR-073). Read once for the loop, and after the
  // moves above, so a run this pass parked is judged against this pass's snapshot state.
  const retentionExpired = await parkedBeyondSnapshotRetention(db, now)

  for (const seat of await liveCredentialSeats(db)) {
    const expiredAt = retentionExpired.get(seat.workflowId)

    // The exclusion that matters. `state === null` is a run that no longer exists; anything else is
    // judged by the one rule, which keeps every live state — `paused` and `awaiting_credential`
    // included — and the one terminal state that is only parked. The retention check is the single
    // exception to that last clause, and it is an exception FR-073 writes out in full: a parked run
    // keeps its seat *for as long as it can be resumed*, and once its snapshot has passed retention
    // it cannot be, so the park has stopped being a pause and become an ending.
    if (seat.state !== null && !releasesAgentCredential(seat.state) && expiredAt === undefined) {
      continue
    }

    const reason =
      seat.state === null
        ? `workflow ${seat.workflowId} no longer exists; the seat it reserved was stranded`
        : expiredAt !== undefined
          ? `workflow is ${seat.state} and its durable snapshot stopped being retained at ${expiredAt.toISOString()}; the run can no longer be resumed onto the seat it was holding, so the seat goes back to the pool (003/FR-073)`
          : `workflow is ${seat.state}; the seat outlived the run`

    // `forced`, with no `releasedByUserId`: the platform taking a seat back after a run that is not
    // there to do it, which the null actor on the `force_released` audit entry is what records.
    const outcome = await releaseAgentCredentialLease({
      db,
      workflowId: seat.workflowId,
      reason: 'forced',
    })

    if (outcome.outcome === 'released') {
      releasedSeats.push({
        leaseId: outcome.leaseId,
        workflowId: seat.workflowId,
        agentCredentialId: outcome.agentCredentialId,
        workflowState: seat.state ?? undefined,
        credentialState: outcome.credentialState,
        reason,
      })
    }
  }

  // --- The cooling-off return sweep (003/FR-076, FR-078, SC-019) --------------------------------
  //
  // Last, because it is the only step that *adds* capacity, and the drain below is what puts that
  // capacity in front of the waiting queue in this pass rather than the next one.

  const returnedToPool: ReturnedCredential[] = []

  for (const cooling of await coolingOffCredentials(db, now, coolingOffRetryMs)) {
    const reason =
      cooling.coolingOffUntil === null
        ? `the provider named no return time and the ${String(Math.round(coolingOffRetryMs / 60_000))}-minute retry interval has elapsed, so the credential is offered to the pool again rather than left cooling off indefinitely`
        : `the provider's stated limit cleared at ${cooling.coolingOffUntil.toISOString()}`

    // Conditional on the row still being `cooling_off`, so a credential disabled or claimed while
    // this pass was running is left where it is. Returning a seat is not a repair: if the limit has
    // not really cleared, the next refusal puts it straight back.
    const outcome = await returnFromCoolingOff({ db, agentCredentialId: cooling.id, reason })

    if (outcome.outcome === 'changed') {
      returnedToPool.push({
        agentCredentialId: cooling.id,
        returnedBecause: cooling.coolingOffUntil === null ? 'unstated' : 'stated',
        returnedTo: outcome.to,
        reason,
      })
    }
  }

  let queueDrainError: Error | undefined
  // A freed seat is capacity as much as a freed slot is, and Phase 6's grant path (T065) hangs off
  // the drain — so a pass that released only seats, or only returned cooling-off ones, still has a
  // queue worth re-examining. FR-076's "returns to selection automatically" is this line: without
  // it a credential would be available and the run waiting for it would sit until the next tick.
  if (
    (released.length > 0 || releasedSeats.length > 0 || returnedToPool.length > 0) &&
    options.queueDrain !== undefined
  ) {
    try {
      await options.queueDrain.drain()
    } catch (thrown) {
      queueDrainError = toError(thrown)
    }
  }

  return {
    moved,
    released,
    terminated,
    releasedSeats,
    returnedToPool,
    validationInstances,
    healthy,
    queueDrainError,
    notificationErrors,
  }
}

/** The sweep wrapped in the uniform job envelope. */
export const runReconcile = (options: ReconcileOptions): Promise<JobOutcome<ReconcileResult>> =>
  runJob(RECONCILE_JOB_NAME, () => reconcile(options))
