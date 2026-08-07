import type { SisyphusDatabase, Workflow } from '@bluetel-ai/sisyphus-api/db'
import {
  computeLeases,
  sessionSnapshots,
  terminalOutcomeEnum,
  workflowEvents,
  workflows,
} from '@bluetel-ai/sisyphus-api/db'
import type { WorkflowNotifier } from '@bluetel-ai/sisyphus-notify'
import { notificationEventForState } from '@bluetel-ai/sisyphus-notify'
import { and, eq, inArray, isNull } from 'drizzle-orm'

import type { ComputeProvisioner } from '../aws'
import { revokeScopedCredentials } from '../credentials'

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
 * ## Order within one pass
 *
 * Workflows are moved first, then leases are swept, then instances. That way a run this pass has
 * just declared dead has its lease released and its instance destroyed in the same pass, rather
 * than waiting for the next one — which is what keeps a lapsed run inside SC-007's ten minutes.
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
 * the number lives there. Two copies of one threshold in two apps is not ideal — the shared home
 * would be `packages/sisyphus-api` — but the duplication is at least honest, because the two are
 * not doing the same job: the executor's is the one that normally fires, and this is the backstop
 * for the case where it could not.
 */
export const PAUSE_IDLE_CEILING_MS = 30 * 60 * 1000

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

/** States in which a workflow may still be holding compute. A lease outliving one of these leaks. */
const ACTIVE_STATES = ['provisioning', 'running', 'paused'] as const

export interface ReconcileOptions {
  readonly db: SisyphusDatabase
  readonly compute: ComputeProvisioner
  /** Injectable clock, so the thresholds are testable without waiting. */
  readonly now?: () => Date
  readonly heartbeatLapseMs?: number
  readonly provisioningGraceMs?: number
  readonly pauseIdleCeilingMs?: number
  readonly pauseIdleGraceMs?: number
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

export interface ReconcileResult {
  /** Direction two: workflows whose compute vanished or fell silent. */
  readonly moved: readonly MovedWorkflow[]
  /** Direction one: leases outliving their run. */
  readonly released: readonly ReleasedLease[]
  /** Direction one: instances nothing holds a lease for. */
  readonly terminated: readonly TerminatedInstance[]
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

const isTerminal = (state: Workflow['state']): boolean =>
  (terminalOutcomeEnum.enumValues as readonly string[]).includes(state)

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

    if (locked === undefined || isTerminal(locked.state)) {
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
    if (!isTerminal(lease.state)) {
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

  let queueDrainError: Error | undefined
  if (released.length > 0 && options.queueDrain !== undefined) {
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
    validationInstances,
    healthy,
    queueDrainError,
    notificationErrors,
  }
}

/** The sweep wrapped in the uniform job envelope. */
export const runReconcile = (options: ReconcileOptions): Promise<JobOutcome<ReconcileResult>> =>
  runJob(RECONCILE_JOB_NAME, () => reconcile(options))
