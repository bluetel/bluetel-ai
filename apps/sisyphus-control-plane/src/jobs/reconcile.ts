import type { SisyphusDatabase, Workflow } from '@bluetel-ai/sisyphus-api/db'
import {
  computeLeases,
  sessionSnapshots,
  terminalOutcomeEnum,
  workflowEvents,
  workflows,
} from '@bluetel-ai/sisyphus-api/db'
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

/** States in which a workflow may still be holding compute. A lease outliving one of these leaks. */
const ACTIVE_STATES = ['provisioning', 'running', 'paused'] as const

export interface ReconcileOptions {
  readonly db: SisyphusDatabase
  readonly compute: ComputeProvisioner
  /** Injectable clock, so the thresholds are testable without waiting. */
  readonly now?: () => Date
  readonly heartbeatLapseMs?: number
  readonly provisioningGraceMs?: number
  /** Run once at the end if anything was released, for the same reason teardown runs it. */
  readonly queueDrain?: QueueDrain
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

  const instances = await compute.listWorkflowInstances()
  const liveInstanceIds = new Set(instances.map((instance) => instance.instanceId))

  const leases = await liveLeases(db)
  const leaseByWorkflow = new Map(leases.map((lease) => [lease.workflowId, lease]))

  // --- Direction two: a workflow whose lease vanished or whose heartbeat lapsed ----------------

  const activeWorkflows = await db
    .select({ id: workflows.id, state: workflows.state })
    .from(workflows)
    .where(inArray(workflows.state, [...ACTIVE_STATES]))

  const moved: MovedWorkflow[] = []
  let healthy = 0

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

    if (reason === undefined) {
      healthy += 1
      continue
    }

    const move = await moveWorkflow({ db, workflowId: workflow.id, reason, now })
    if (move !== undefined) {
      moved.push(move)
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

  return { moved, released, terminated, validationInstances, healthy, queueDrainError }
}

/** The sweep wrapped in the uniform job envelope. */
export const runReconcile = (options: ReconcileOptions): Promise<JobOutcome<ReconcileResult>> =>
  runJob(RECONCILE_JOB_NAME, () => reconcile(options))
