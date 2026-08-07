import type { SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'
import {
  bootstrapPhases,
  computeLeases,
  sessionSnapshots,
  setupBundleVersions,
  workflowEntries,
  workflowEvents,
  workflows,
} from '@bluetel-ai/sisyphus-api/db'
import { and, asc, desc, eq, isNull, max } from 'drizzle-orm'

import type { ComputeProvisioner } from '../aws'
import { mintScopedCredential, revokeScopedCredentials } from '../credentials'

import type { AdmittedWorkflow, WorkflowStarter } from './admit-workflow'
import { workflowInstanceTag } from './instance-tag'
import type { EnvelopeWorkspaceEntry, WorkflowJobEnvelope } from './job-envelope'
import { encodeUserData, WORKSPACE_ROOT } from './job-envelope'
import type { JobOutcome } from './run-job'
import { runJob } from './run-job'

/**
 * Provisioning (T052, FR-036) — the step that turns an admitted workflow into a running instance.
 *
 * This is the implementation of the {@link WorkflowStarter} seam `admit-workflow.ts` declares, and
 * the reason that seam exists is the ordering: provisioning runs **after** the admitting
 * transaction commits. A launch takes seconds and can fail; holding the platform-wide admission
 * lock across it would serialise every other launch behind an EC2 call, and rolling the admission
 * back on a launch failure would release a lease the instance may in fact hold. So the lease stands
 * either way, the failure lands in `DrainQueueResult.startFailures`, and the FR-039 reconciler is
 * the backstop.
 *
 * ## Sized and priced per the job spec, never per a default here
 *
 * `instance_type` and `purchase_mode` are read off the workflow row, which is write-once (FR-149).
 * There is no fallback in this module: a run whose spec says `on_demand` is not quietly launched on
 * spot because a default said so, and a run on an instance family this code has never heard of
 * launches anyway, because the type is stored as text and narrowed by EC2 rather than by a union
 * that would need a dependency bump to learn a new family.
 *
 * ## What the credential does before the instance exists
 *
 * The credential is minted **before** the launch, because it has to be inside the envelope the
 * launch carries. That means a failed launch leaves a live credential for an instance that never
 * booted, so the failure path revokes it. Not revoking would be survivable — the next mint
 * supersedes the incumbent anyway — but it would leave a credential that is live, unrevoked and
 * attached to nothing, which is exactly the state an audit of `scoped_credentials` should never
 * have to explain.
 *
 * ## Why a second start cannot produce a second instance
 *
 * FR-078's guarantee is `compute_leases_live_key`, and it is what makes two concurrent admissions
 * produce one lease. But `start` can still be reached twice for one admission — a retried hand-off,
 * or the reconciler and the drain arriving together — so the lease's `provider_instance_id` is
 * claimed with a compare-and-set: the update matches only while the column is still null. A start
 * that loses that race terminates the instance it just launched and reports
 * {@link AlreadyStartedWorkflow}. Terminating rather than leaking is the point; the loser is the
 * only party that knows the id of the instance nobody recorded.
 */

export const START_WORKFLOW_JOB_NAME = 'start-workflow'

/** Everything provisioning needs that is not the workflow itself. */
export interface StartWorkflowDependencies {
  readonly db: SisyphusDatabase
  readonly compute: ComputeProvisioner
  /** `SISYPHUS_MACHINE_SURFACE_URL` — the only URL the instance is told about. */
  readonly machineSurfaceUrl: string
  /** `SISYPHUS_MACHINE_CREDENTIAL_SECRET`. Never in the envelope; only what it signs is. */
  readonly credentialSecret: string
  /** Injectable clock, so the recorded timestamps are data rather than timing. */
  readonly now?: () => Date
}

export interface StartWorkflowOptions extends StartWorkflowDependencies {
  readonly workflowId: string
}

/** The instance is up and the lease records it. */
export interface StartedWorkflow {
  readonly outcome: 'started'
  readonly workflowId: string
  readonly instanceId: string
  readonly instanceType: string
  readonly purchaseMode: string
  readonly credentialId: string
  /** Bytes of user data, so an envelope creeping towards the cap is visible before it hits it. */
  readonly userDataBytes: number
}

/** Someone else already recorded an instance against this lease. Not an error (FR-078). */
export interface AlreadyStartedWorkflow {
  readonly outcome: 'already_started'
  readonly workflowId: string
  /** The instance already on the lease. */
  readonly instanceId: string
  /** Launched by this call and immediately destroyed, if it got that far. */
  readonly terminatedInstanceId: string | undefined
}

/** The run is not in a state provisioning may act on — cancelled, or already running. */
export interface NotStartable {
  readonly outcome: 'not_startable'
  readonly workflowId: string
  readonly reason: string
}

export type StartWorkflowOutcome = AlreadyStartedWorkflow | NotStartable | StartedWorkflow

/** See `admit-workflow.ts`: `noUncheckedIndexedAccess` is off, so indexing needs an honest type. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/**
 * Record the outcome of the `provisioning` bootstrap phase.
 *
 * Phase 1 belongs to the control plane — `executor-protocol.md` says so explicitly — and recording
 * it is what stops the panel showing an opaque "provisioning" of unknown duration before the
 * executor is alive enough to report anything of its own (FR-145). A failed launch is recorded the
 * same way, so a capacity refusal appears on the timeline as a named phase rather than as silence.
 */
const recordProvisioningPhase = async (
  db: SisyphusDatabase,
  workflowId: string,
  outcome: 'failed' | 'succeeded',
  detail: string | null,
): Promise<void> => {
  await db.transaction(async (tx) => {
    // The row is locked first for the same reason `reportBootstrapPhase` locks it: `sequence` is
    // allocated by counting what is already there, and two allocators reading the same number lose
    // on `bootstrap_phases_sequence_key`.
    await tx
      .select({ id: workflows.id })
      .from(workflows)
      .where(eq(workflows.id, workflowId))
      .for('update')

    const highest = firstRow(
      await tx
        .select({ value: max(bootstrapPhases.sequence) })
        .from(bootstrapPhases)
        .where(eq(bootstrapPhases.workflowId, workflowId)),
    )

    await tx.insert(bootstrapPhases).values({
      workflowId,
      phase: 'provisioning',
      sequence: (highest?.value ?? 0) + 1,
      outcome,
      detail,
      endedAt: new Date(),
    })
  })
}

/** The workspace entries this run checks out, in position order. */
const entriesFor = async (
  db: SisyphusDatabase,
  workflowId: string,
): Promise<readonly EnvelopeWorkspaceEntry[]> => {
  const rows = await db
    .select({
      entryId: workflowEntries.id,
      repositoryUrl: workflowEntries.repositoryUrl,
      baseBranch: workflowEntries.baseBranch,
      subdirectory: workflowEntries.subdirectory,
      isPrimary: workflowEntries.isPrimary,
    })
    .from(workflowEntries)
    .where(eq(workflowEntries.workflowId, workflowId))
    // Primary first, then a stable order. The executor checks out in the order given, and a
    // shuffling order would make two runs of the same workspace produce different phase sequences.
    .orderBy(desc(workflowEntries.isPrimary), asc(workflowEntries.subdirectory))

  return rows
}

/**
 * Assemble the envelope for one run.
 *
 * @throws If the run has no workspace entries, no assembled prompt, or no live lease — each of
 *   which would produce an instance that boots and then has nothing to do, which is a worse
 *   failure than not launching.
 */
const assembleEnvelope = async (
  options: StartWorkflowOptions,
  scopedCredential: string,
): Promise<WorkflowJobEnvelope> => {
  const { db, workflowId } = options

  const workflow = firstRow(
    await db
      .select({
        id: workflows.id,
        type: workflows.type,
        sessionId: workflows.sessionId,
        model: workflows.model,
        turnCap: workflows.turnCap,
        spendCap: workflows.spendCap,
        assembledPrompt: workflows.assembledPrompt,
        currentSnapshotId: workflows.currentSnapshotId,
        bundleS3Key: setupBundleVersions.s3Key,
        bundleDigest: setupBundleVersions.contentDigest,
        bundleVersion: setupBundleVersions.version,
      })
      .from(workflows)
      .innerJoin(setupBundleVersions, eq(setupBundleVersions.id, workflows.setupBundleVersionId))
      .where(eq(workflows.id, workflowId))
      .limit(1),
  )

  if (workflow === undefined) {
    throw new Error(
      `Workflow ${workflowId} does not exist, so there is no job specification to launch against.`,
    )
  }

  if (workflow.assembledPrompt === null) {
    throw new Error(
      `Workflow ${workflowId} has no assembled prompt. A run with nothing to do would boot, bootstrap and then have to be torn down, so it is refused before an instance is paid for.`,
    )
  }

  const entries = await entriesFor(db, workflowId)
  if (entries.length === 0) {
    throw new Error(
      `Workflow ${workflowId} has no workspace entries. FR-112 forbids starting the agent against an incomplete workspace, and an empty one is the limiting case.`,
    )
  }

  const snapshot =
    workflow.currentSnapshotId === null
      ? undefined
      : firstRow(
          await db
            .select({ s3Key: sessionSnapshots.s3Key, sessionId: sessionSnapshots.sessionId })
            .from(sessionSnapshots)
            .where(eq(sessionSnapshots.id, workflow.currentSnapshotId))
            .limit(1),
        )

  return {
    workflowId,
    sessionId: workflow.sessionId,
    machineSurfaceUrl: options.machineSurfaceUrl,
    scopedCredential,
    setupBundle: {
      s3Key: workflow.bundleS3Key,
      contentDigest: workflow.bundleDigest,
      version: workflow.bundleVersion,
    },
    workspace: { root: WORKSPACE_ROOT, entries },
    job: {
      model: workflow.model,
      turnCap: workflow.turnCap,
      spendCap: workflow.spendCap,
      workflowType: workflow.type,
    },
    // Only `assembled` is known here. The parts are recorded by the prompt assembler, which is a
    // separate task; carrying an empty `preamble` would say something false about the run.
    prompt: { assembled: workflow.assembledPrompt },
    // Restore replaces bootstrap phases 6 and 7. A run with no current snapshot omits the field
    // entirely rather than carrying a null, because the executor branches on its presence.
    ...(snapshot === undefined
      ? {}
      : { resumeFromSnapshot: { s3Key: snapshot.s3Key, sessionId: snapshot.sessionId } }),
    mode: 'workflow',
  }
}

/**
 * Provision the instance for one admitted workflow.
 *
 * @param options - The dependencies plus the run to start.
 * @returns What happened. A launch failure is **thrown**, not returned, because the caller's
 *   contract (`DrainQueueResult.startFailures`) is written around a rejection and because the
 *   lease must be left intact for the reconciler either way.
 */
export const startWorkflow = async (
  options: StartWorkflowOptions,
): Promise<StartWorkflowOutcome> => {
  const { compute, credentialSecret, db, workflowId } = options
  const now = options.now ?? ((): Date => new Date())

  const lease = firstRow(
    await db
      .select({
        id: computeLeases.id,
        instanceType: computeLeases.instanceType,
        purchaseMode: computeLeases.purchaseMode,
        providerInstanceId: computeLeases.providerInstanceId,
      })
      .from(computeLeases)
      .where(and(eq(computeLeases.workflowId, workflowId), isNull(computeLeases.releasedAt)))
      .limit(1),
  )

  if (lease === undefined) {
    return {
      outcome: 'not_startable',
      workflowId,
      reason:
        'The run holds no live compute lease. Provisioning is only ever reached through admission, which takes the lease, so a missing one means the run was released or never admitted.',
    }
  }

  if (lease.providerInstanceId !== null) {
    return {
      outcome: 'already_started',
      workflowId,
      instanceId: lease.providerInstanceId,
      terminatedInstanceId: undefined,
    }
  }

  const credential = await mintScopedCredential({
    db,
    workflowId,
    secret: credentialSecret,
    now: now(),
  })

  let launched
  let userDataBytes = 0
  try {
    const userData = encodeUserData(
      await assembleEnvelope(options, credential.token),
      `workflow ${workflowId}`,
    )
    userDataBytes = Buffer.byteLength(userData, 'utf8')

    launched = await compute.launch({
      workflowId: workflowInstanceTag(workflowId),
      // Straight off the write-once job spec, which is where FR-036's "sized and priced per the
      // job specification" is decided. This module chooses nothing.
      instanceType: lease.instanceType,
      purchaseMode: lease.purchaseMode,
      userData,
    })
  } catch (thrown) {
    // The credential can never be used: no instance holds it. Revoking keeps
    // `scoped_credentials` free of live rows attached to nothing.
    await revokeScopedCredentials({ db, workflowId, now: now() })
    await recordProvisioningPhase(
      db,
      workflowId,
      'failed',
      thrown instanceof Error ? thrown.message : String(thrown),
    )
    throw thrown
  }

  // Compare-and-set. Only the caller that finds the column still null owns this lease's instance.
  const claimed = firstRow(
    await db
      .update(computeLeases)
      .set({ providerInstanceId: launched.instanceId, readyAt: now() })
      .where(
        and(
          eq(computeLeases.id, lease.id),
          isNull(computeLeases.releasedAt),
          isNull(computeLeases.providerInstanceId),
        ),
      )
      .returning({ id: computeLeases.id }),
  )

  if (claimed === undefined) {
    const current = firstRow(
      await db
        .select({ providerInstanceId: computeLeases.providerInstanceId })
        .from(computeLeases)
        .where(eq(computeLeases.id, lease.id))
        .limit(1),
    )

    // Nobody else knows this instance exists. Leaving it running would be a leak the reconciler
    // would eventually find and bill for in the meantime.
    await compute.terminate({ instanceId: launched.instanceId })

    return {
      outcome: 'already_started',
      workflowId,
      instanceId: current?.providerInstanceId ?? launched.instanceId,
      terminatedInstanceId: launched.instanceId,
    }
  }

  await recordProvisioningPhase(db, workflowId, 'succeeded', launched.instanceId)

  await db.insert(workflowEvents).values({
    workflowId,
    event: 'provisioned',
    actorType: 'control_plane',
    detail: {
      instanceId: launched.instanceId,
      instanceType: launched.instanceType,
      purchaseMode: launched.purchaseMode,
      credentialId: credential.credentialId,
      userDataBytes,
    },
  })

  return {
    outcome: 'started',
    workflowId,
    instanceId: launched.instanceId,
    instanceType: launched.instanceType,
    purchaseMode: launched.purchaseMode,
    credentialId: credential.credentialId,
    userDataBytes,
  }
}

/**
 * The {@link WorkflowStarter} the queue drain takes.
 *
 * @param dependencies - Everything provisioning needs except the run.
 */
export const createWorkflowStarter = (
  dependencies: StartWorkflowDependencies,
): WorkflowStarter => ({
  start: async (admitted: AdmittedWorkflow): Promise<void> => {
    await startWorkflow({ ...dependencies, workflowId: admitted.workflowId })
  },
})

/** Provisioning wrapped in the uniform job envelope. */
export const runStartWorkflow = (
  options: StartWorkflowOptions,
): Promise<JobOutcome<StartWorkflowOutcome>> =>
  runJob(START_WORKFLOW_JOB_NAME, () => startWorkflow(options))
