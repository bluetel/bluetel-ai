import type { SisyphusDatabase, Workflow } from '@bluetel-ai/sisyphus-api/db'
import {
  artifacts,
  computeLeases,
  logSegments,
  sessionSnapshots,
  terminalOutcomeEnum,
  workflows,
} from '@bluetel-ai/sisyphus-api/db'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'

import type { ComputeProvisioner, ObjectStore } from '../aws'
import { revokeScopedCredentials } from '../credentials'

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

/** Durability confirmed; compute released and credential revoked, in that order. */
export interface ReleasedTeardown {
  readonly outcome: 'released'
  readonly workflowId: string
  readonly terminatedInstanceId: string | undefined
  readonly credentialsRevoked: number
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
 * Whether a run has finished.
 *
 * Read off `terminalOutcomeEnum` rather than from a list restated here: the outcome names double
 * as states so `workflows.state` and `workflows.terminal_outcome` cannot disagree, and deriving
 * this from the same enum the column is typed by means a seventh outcome is understood by teardown
 * the day it is added.
 */
const isTerminal = (state: Workflow['state']): boolean =>
  (terminalOutcomeEnum.enumValues as readonly string[]).includes(state)

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

  if (!isTerminal(workflow.state)) {
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
    return { outcome: 'already_released', workflowId, credentialsRevoked: revocation.revoked }
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
