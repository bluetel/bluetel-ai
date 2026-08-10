import type { SisyphusDatabase, Workflow } from '@bluetel-ai/sisyphus-api/db'
import {
  artifacts,
  computeLeases,
  credentialLeases,
  logSegments,
  sessionSnapshots,
  workflows,
} from '@bluetel-ai/sisyphus-api/db'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'

import type { ComputeProvisioner, ObjectStore } from '../aws'
import { revokeScopedCredentials } from '../credentials'
import { releaseLease } from '../credentials/lease'

import { isTerminalWorkflowState, releasesAgentCredential } from './agent-credential-release'
import type { JobOutcome } from './run-job'
import { runJob, toError } from './run-job'

/**
 * Teardown (T066, FR-038) — **confirm durability, then** release compute and revoke the credential.
 *
 * ## The order is the requirement
 *
 * FR-038 does not say "destroy the instance and check the logs got saved". It says confirm, and
 * only then destroy. The reason is that these two steps fail in wildly asymmetric ways. If
 * confirmation fails *after* the instance is gone, the run's output is gone with it: the segments
 * the executor had buffered, the artifacts it had not yet uploaded, the snapshot it was midway
 * through writing. There is no recovery, because the only copy was on a disk that no longer
 * exists. If confirmation fails *before*, the cost is a few more minutes of an instance nobody is
 * using, and the run's work is still there to be re-uploaded.
 *
 * So durability is a **precondition**, and this job does nothing irreversible until it holds.
 * `teardown-workflow.test.ts` proves the ordering directly — the sequence of calls is recorded —
 * and proves the consequence: with an object missing, `terminate` is never reached.
 *
 * ## The ten-minute budget, made explicit
 *
 * SC-007 gives no instance more than ten minutes past its workflow's terminal state. A teardown
 * that simply waited for durability could hold one forever — an executor killed mid-upload leaves a
 * `log_segments` row pointing at an object that will never appear, and a teardown blocked on it
 * would keep a paid instance alive indefinitely while reporting, correctly, that it was being
 * careful.
 *
 * {@link TEARDOWN_BUDGET_MS} is therefore an explicit deadline measured from the moment the run
 * went terminal. Inside it, an unconfirmed teardown **defers** and says what is missing; the
 * scheduler brings it back. Past it, the release happens anyway — {@link ForcedTeardown} — with
 * the unconfirmed keys named in the lease's `release_reason` so the loss is a recorded fact rather
 * than a silent one. The budget is not a timeout on a network call; it is the answer to "how long
 * may care cost money", and SC-007 sets it at ten minutes.
 *
 * ## Why the drain comes after
 *
 * Releasing a lease frees a slot under the FR-040 ceiling, and nothing else re-examines the queue.
 * `admit-workflow.ts` names the drain as teardown's responsibility for exactly this reason: without
 * it the ceiling builds a queue nothing empties.
 *
 * ## The agent credential seat, and the one terminal outcome that keeps it (003/FR-019, T047)
 *
 * Teardown is where a run hands back its seat in the agent-credential pool. FR-019 makes this the
 * *only* ordinary way one is released — an administrator's force-release (FR-057) and the FR-022
 * sweep are the others, and both are exceptional — so the interesting question is not when this
 * releases but what it must not release.
 *
 * **Pause never reaches here.** A `paused` run is not terminal, so teardown returns
 * {@link NotTerminalTeardown} before it looks at anything: the run keeps its instance, and it keeps
 * its seat.
 *
 * **Park reaches here and must not lose its seat.** This is the case that would be got wrong.
 * `parked_resumable` *is* a terminal outcome, so every terminal check in this file answers true for
 * it, and rightly — parking genuinely does release compute, which is the whole difference between
 * parking and pausing. It does not release the credential: FR-073 says a parked workflow retains it
 * and releases it only when it becomes terminal in some other way, and SC-018 depends on that,
 * because a run resumed from a park onto a different identity would be one workflow performed by
 * two agents. `releasesAgentCredential` in `agent-credential-release.ts` is the single expression of
 * that rule, and it is consulted here rather than restated.
 *
 * **Environment destruction reaches here and takes nothing with it.** The `terminate` call above is
 * the destruction of an execution environment, and it is deliberately not what triggers the seat
 * release — the release is decided by the run's state, one level up. A lease belongs to the
 * workflow, not to any instance (FR-018), so an instance going away — released here, reclaimed as
 * spot capacity, or rebuilt on resume — changes nothing about who holds the seat.
 *
 * It is released **after** compute, so a seat only ever comes free once the run genuinely has no
 * instance, and **before** the drain, so the queue's next pass can grant what this teardown freed.
 */

export const TEARDOWN_WORKFLOW_JOB_NAME = 'teardown-workflow'

/**
 * SC-007's ten minutes, in milliseconds — from the workflow's terminal state to the instance being
 * gone, whether or not durability could be confirmed in that time.
 */
export const TEARDOWN_BUDGET_MS = 10 * 60 * 1000

/** Where each class of durable object lives. All four are separate buckets by lifecycle policy. */
export interface DurabilityBuckets {
  readonly logs: string
  readonly artifacts: string
  readonly snapshots: string
}

/**
 * The queue drain (T051), called **after** a lease is released and never before.
 *
 * A seam rather than a direct call to {@link import('./drain-queue').drainQueue}, because the
 * ceiling is deploy-time configuration and the provisioning starter is a dependency of its own:
 * teardown has no business deciding either, and taking them as parameters would make it the place
 * they were assembled.
 */
export interface QueueDrain {
  readonly drain: () => Promise<void>
}

export interface TeardownWorkflowOptions {
  readonly db: SisyphusDatabase
  readonly compute: ComputeProvisioner
  readonly objectStore: ObjectStore
  readonly buckets: DurabilityBuckets
  readonly workflowId: string
  /** Run after a release, so the freed slot is re-admitted rather than left idle (FR-040). */
  readonly queueDrain?: QueueDrain
  /** Injectable clock, so the budget is testable without waiting ten minutes. */
  readonly now?: () => Date
  /** Overridable for tests; defaults to {@link TEARDOWN_BUDGET_MS}. */
  readonly budgetMs?: number
  /**
   * When the run went terminal. Defaults to the workflow's `updated_at`, which the terminal report
   * touches — the schema carries no `terminal_at`, and SC-007's clock has to start somewhere
   * recorded rather than at whenever teardown happened to be invoked.
   */
  readonly terminalAt?: Date
}

/** An object the record says exists and durable storage says does not. */
export interface MissingObject {
  readonly kind: 'artifact' | 'log_segment' | 'snapshot'
  readonly bucket: string
  readonly key: string
}

/**
 * What teardown did about the run's seat in the agent-credential pool (FR-019, FR-073).
 *
 * Three answers rather than a boolean, because `retained` and `not_held` mean opposite things about
 * the pool and collapsing them would hide the one that matters. `retained` is a seat still claimed
 * by a parked run — capacity consumed indefinitely by something showing no activity, which FR-074
 * calls the likeliest cause of unexplained pool exhaustion — and `not_held` is a run that never had
 * one. A caller reading `false` could not tell a healthy park from a leak.
 */
export interface AgentCredentialDisposition {
  readonly outcome: 'not_held' | 'released' | 'retained'
  /** The seat, where there was one to name. */
  readonly agentCredentialId: string | undefined
}

/** Durability confirmed; compute released and credential revoked, in that order. */
export interface ReleasedTeardown {
  readonly outcome: 'released'
  readonly workflowId: string
  readonly terminatedInstanceId: string | undefined
  readonly credentialsRevoked: number
  readonly agentCredential: AgentCredentialDisposition
  readonly confirmedObjects: number
  /**
   * The drain ran and threw. Reported rather than raised: the lease is already released, and a
   * teardown that reported failure would be retried against a lease it had itself released.
   */
  readonly queueDrainError: Error | undefined
}

/** Durability not confirmed and the budget has not run out. Nothing was destroyed. */
export interface DeferredTeardown {
  readonly outcome: 'deferred'
  readonly workflowId: string
  readonly missing: readonly MissingObject[]
  /** When the budget runs out and the next attempt will release regardless. */
  readonly deadline: Date
  readonly remainingMs: number
}

/** The budget ran out with durability unconfirmed. Released anyway, with the loss recorded. */
export interface ForcedTeardown {
  readonly outcome: 'forced'
  readonly workflowId: string
  readonly terminatedInstanceId: string | undefined
  readonly credentialsRevoked: number
  readonly agentCredential: AgentCredentialDisposition
  readonly missing: readonly MissingObject[]
  readonly deadline: Date
  /** See {@link ReleasedTeardown.queueDrainError}. */
  readonly queueDrainError: Error | undefined
}

/** No live lease. Teardown retries and the reconciler sweeps; both must converge, not error. */
export interface AlreadyReleasedTeardown {
  readonly outcome: 'already_released'
  readonly workflowId: string
  readonly credentialsRevoked: number
  readonly agentCredential: AgentCredentialDisposition
}

/** The run has not finished. FR-038 is about completion, so there is nothing to tear down yet. */
export interface NotTerminalTeardown {
  readonly outcome: 'not_terminal'
  readonly workflowId: string
  readonly state: Workflow['state']
}

export type TeardownOutcome =
  | AlreadyReleasedTeardown
  | DeferredTeardown
  | ForcedTeardown
  | NotTerminalTeardown
  | ReleasedTeardown

/** See `admit-workflow.ts`: `noUncheckedIndexedAccess` is off, so indexing needs an honest type. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/**
 * Hand the run's seat in the agent-credential pool back, unless its state says it still owns it.
 *
 * The guard is the requirement, not a precaution. See the module note: pause never gets this far,
 * and park does — `parked_resumable` is terminal, so everything else in this file treats it as a
 * finished run, and this one rule is the reason its agent credential survives to be resumed onto
 * (FR-073, SC-018).
 *
 * `terminal` is the recorded reason (FR-019) and `released_by_user_id` stays null, which is what
 * distinguishes a run finishing from an administrator seizing a seat (FR-057). The audit entry is
 * written by `releaseLease` inside the same transaction as the release itself (FR-058).
 *
 * Calling it twice is safe: teardown is a job, jobs are retried, and the second call matches no live
 * lease and answers `not_held` rather than freeing a seat some later run has since taken.
 */
const handBackAgentCredential = async (options: {
  readonly db: SisyphusDatabase
  readonly workflowId: string
  readonly state: Workflow['state']
}): Promise<AgentCredentialDisposition> => {
  if (!releasesAgentCredential(options.state)) {
    // Named rather than merely left alone, so a parked run's hold on the pool is legible to the
    // caller — FR-074's "which credentials are held by parked workflows" starts here.
    const held = firstRow(
      await options.db
        .select({ id: credentialLeases.agentCredentialId })
        .from(credentialLeases)
        .where(
          and(
            eq(credentialLeases.workflowId, options.workflowId),
            isNull(credentialLeases.releasedAt),
          ),
        )
        .limit(1),
    )

    return { outcome: 'retained', agentCredentialId: held?.id }
  }

  const released = await releaseLease({
    db: options.db,
    workflowId: options.workflowId,
    reason: 'terminal',
  })

  return released.outcome === 'released'
    ? { outcome: 'released', agentCredentialId: released.agentCredentialId }
    : { outcome: 'not_held', agentCredentialId: undefined }
}

/**
 * Everything the record says the run persisted, checked against durable storage.
 *
 * Every `log_segments` row, every `artifacts` row that names an object (a pull request lives
 * elsewhere and has no key to check), and the current snapshot. The rows are the claim; `head` is
 * the confirmation. FR-038 asks for the confirmation, and a teardown that trusted the rows would
 * be confirming that the executor *said* it had persisted things.
 *
 * @returns The objects that are missing, and how many were confirmed present.
 */
export const confirmDurability = async (options: {
  readonly db: SisyphusDatabase
  readonly objectStore: ObjectStore
  readonly buckets: DurabilityBuckets
  readonly workflowId: string
}): Promise<{ readonly missing: readonly MissingObject[]; readonly confirmed: number }> => {
  const { buckets, db, objectStore, workflowId } = options

  const expected: readonly MissingObject[] = [
    ...(
      await db
        .select({ key: logSegments.s3Key })
        .from(logSegments)
        .where(eq(logSegments.workflowId, workflowId))
    ).map((row) => ({ kind: 'log_segment' as const, bucket: buckets.logs, key: row.key })),

    ...(
      await db
        .select({ key: artifacts.s3Key })
        .from(artifacts)
        .where(and(eq(artifacts.workflowId, workflowId), isNotNull(artifacts.s3Key)))
    ).flatMap((row) =>
      row.key === null
        ? []
        : [{ kind: 'artifact' as const, bucket: buckets.artifacts, key: row.key }],
    ),

    ...(
      await db
        .select({ key: sessionSnapshots.s3Key })
        .from(sessionSnapshots)
        .where(
          and(eq(sessionSnapshots.workflowId, workflowId), eq(sessionSnapshots.isCurrent, true)),
        )
    ).map((row) => ({ kind: 'snapshot' as const, bucket: buckets.snapshots, key: row.key })),
  ]

  const missing: MissingObject[] = []
  for (const object of expected) {
    const found = await objectStore.head({ bucket: object.bucket, key: object.key })
    if (found === undefined) {
      missing.push(object)
    }
  }

  return { missing, confirmed: expected.length - missing.length }
}

/**
 * Destroy the instance, release the lease and revoke the credential — in that order.
 *
 * Terminating first is deliberate: the lease is the platform's record that an instance exists, and
 * releasing it before the instance is actually gone would make the run invisible to the very sweep
 * that would otherwise catch a failed termination. If `terminate` throws, the lease is still there
 * and the reconciler still knows to look.
 *
 * Revocation comes last because it cannot fail in a way that matters and must not be skipped: the
 * update is idempotent, so a retried teardown revokes nothing and reports zero.
 */
const releaseCompute = async (options: {
  readonly db: SisyphusDatabase
  readonly compute: ComputeProvisioner
  readonly workflowId: string
  readonly leaseId: string
  readonly instanceId: string | null
  readonly reason: string
  readonly now: Date
}): Promise<{ readonly terminatedInstanceId: string | undefined; readonly revoked: number }> => {
  if (options.instanceId !== null) {
    await options.compute.terminate({ instanceId: options.instanceId })
  }

  await options.db
    .update(computeLeases)
    .set({ releasedAt: options.now, releaseReason: options.reason })
    .where(and(eq(computeLeases.id, options.leaseId), isNull(computeLeases.releasedAt)))

  const revocation = await revokeScopedCredentials({
    db: options.db,
    workflowId: options.workflowId,
    now: options.now,
  })

  return {
    terminatedInstanceId: options.instanceId ?? undefined,
    revoked: revocation.revoked,
  }
}

/**
 * Run the drain, if one was supplied, and report rather than raise.
 *
 * The lease is already released by the time this is called, so a drain failure must not turn a
 * completed teardown into a job failure that something will retry.
 */
const drainAfterRelease = async (
  queueDrain: QueueDrain | undefined,
): Promise<Error | undefined> => {
  if (queueDrain === undefined) {
    return undefined
  }

  try {
    await queueDrain.drain()
    return undefined
  } catch (thrown) {
    return toError(thrown)
  }
}

/**
 * Tear one finished run down.
 *
 * @param options - The handle, the two AWS seams, the buckets and the run.
 * @returns Which of the five things happened. `deferred` is the only one that leaves work to do.
 */
export const teardownWorkflow = async (
  options: TeardownWorkflowOptions,
): Promise<TeardownOutcome> => {
  const { compute, db, workflowId } = options
  const now = (options.now ?? ((): Date => new Date()))()
  const budgetMs = options.budgetMs ?? TEARDOWN_BUDGET_MS

  const workflow = firstRow(
    await db
      .select({ state: workflows.state, updatedAt: workflows.updatedAt })
      .from(workflows)
      .where(eq(workflows.id, workflowId))
      .limit(1),
  )

  if (workflow === undefined) {
    throw new Error(
      `Workflow ${workflowId} does not exist, so there is nothing to tear down. An instance may still be tagged with this id, which is the reconciler's problem rather than this job's.`,
    )
  }

  // Where pause stops. A `paused` run holds its instance and its seat, and neither the compute
  // release below nor the agent-credential release beyond it is reachable from here (FR-019).
  if (!isTerminalWorkflowState(workflow.state)) {
    return { outcome: 'not_terminal', workflowId, state: workflow.state }
  }

  const lease = firstRow(
    await db
      .select({ id: computeLeases.id, providerInstanceId: computeLeases.providerInstanceId })
      .from(computeLeases)
      .where(and(eq(computeLeases.workflowId, workflowId), isNull(computeLeases.releasedAt)))
      .limit(1),
  )

  if (lease === undefined) {
    // Revoked anyway. A lease released by the reconciler took the compute; it is this job that
    // owns the credential, and leaving a live one for a finished run is the leak FR-038 closes.
    const revocation = await revokeScopedCredentials({ db, workflowId, now })
    return {
      outcome: 'already_released',
      workflowId,
      credentialsRevoked: revocation.revoked,
      // And the seat too, for the same reason: whoever took the compute did not take this, and a
      // finished run holding one is capacity nobody can account for.
      agentCredential: await handBackAgentCredential({ db, workflowId, state: workflow.state }),
    }
  }

  const { confirmed, missing } = await confirmDurability({
    db,
    objectStore: options.objectStore,
    buckets: options.buckets,
    workflowId,
  })

  const deadline = new Date((options.terminalAt ?? workflow.updatedAt).getTime() + budgetMs)

  if (missing.length === 0) {
    const released = await releaseCompute({
      db,
      compute,
      workflowId,
      leaseId: lease.id,
      instanceId: lease.providerInstanceId,
      reason: `workflow ${workflow.state}; ${String(confirmed)} durable objects confirmed`,
      now,
    })

    return {
      outcome: 'released',
      workflowId,
      terminatedInstanceId: released.terminatedInstanceId,
      credentialsRevoked: released.revoked,
      // After compute, so a seat only comes free once the run truly has no instance — and before
      // the drain, so the queue's next pass can grant what this teardown freed.
      agentCredential: await handBackAgentCredential({ db, workflowId, state: workflow.state }),
      confirmedObjects: confirmed,
      // After the release, never before: the slot the drain is allowed to fill is the one this
      // release just freed.
      queueDrainError: await drainAfterRelease(options.queueDrain),
    }
  }

  if (now.getTime() < deadline.getTime()) {
    return {
      outcome: 'deferred',
      workflowId,
      missing,
      deadline,
      remainingMs: deadline.getTime() - now.getTime(),
    }
  }

  // The budget is spent. SC-007 wins over the confirmation, because an instance held indefinitely
  // by an object that is never going to appear is a bill with no end, and the loss is recorded
  // rather than hidden — which is the difference between "your logs are gone" and silence.
  const released = await releaseCompute({
    db,
    compute,
    workflowId,
    leaseId: lease.id,
    instanceId: lease.providerInstanceId,
    reason: `teardown budget of ${String(budgetMs)}ms exhausted with ${String(missing.length)} unconfirmed objects: ${missing.map((object) => object.key).join(', ')}`,
    now,
  })

  return {
    outcome: 'forced',
    workflowId,
    terminatedInstanceId: released.terminatedInstanceId,
    credentialsRevoked: released.revoked,
    agentCredential: await handBackAgentCredential({ db, workflowId, state: workflow.state }),
    missing,
    deadline,
    queueDrainError: await drainAfterRelease(options.queueDrain),
  }
}

/** Teardown wrapped in the uniform job envelope. */
export const runTeardownWorkflow = (
  options: TeardownWorkflowOptions,
): Promise<JobOutcome<TeardownOutcome>> =>
  runJob(TEARDOWN_WORKFLOW_JOB_NAME, () => teardownWorkflow(options))
