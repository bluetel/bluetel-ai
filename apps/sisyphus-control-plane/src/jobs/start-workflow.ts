import type { AgentCredentialReference } from '@bluetel-ai/sisyphus-api/contracts'
import type { SisyphusDatabase, Workflow } from '@bluetel-ai/sisyphus-api/db'
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
import { releaseLease } from '../credentials/lease'

import type { AdmittedWorkflow, WorkflowStarter } from './admit-workflow'
import { agentCredentialFor } from './admit-workflow'
import { workflowInstanceTag } from './instance-tag'
import type { EnvelopeWorkspaceEntry, WorkflowJobEnvelope } from './job-envelope'
import { encodeUserData, WORKSPACE_ROOT } from './job-envelope'
import type { JobOutcome } from './run-job'
import { runJob } from './run-job'
import type { ResumableSnapshot, SnapshotRecoveryCause } from './snapshot-recovery'
import { giveUpEnvironment, resumableSnapshotFor } from './snapshot-recovery'

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
 *
 * ## The agent credential: named in the envelope, handed back if the launch fails (003, T048)
 *
 * The seat was claimed at admission, before any compute was committed to (FR-016), so provisioning
 * neither selects nor claims one — it reads the run's live lease and writes the **identifiers** into
 * the envelope (FR-012). Not the material: the envelope is user data, and the paragraph above about
 * long-lived secrets applies to an agent credential with none of the scoped credential's
 * mitigations. The instance fetches the material from the machine surface, authorised by the scoped
 * credential this envelope does carry.
 *
 * **A launch that fails hands the seat back** (FR-021). The run reserved a credential and is not
 * going to use it, and unlike the failure paths above there is nothing self-correcting about
 * holding on to it: the run stays `provisioning` until the FR-039 reconciler moves it, which is a
 * grace period of twenty minutes, and a seat is the platform's scarcest resource. A run whose
 * provisioning failed would otherwise sit on an identity nobody could see was stranded — which is
 * exactly the invisibility FR-021 names.
 *
 * It is released as `forced` rather than `terminal`, and the distinction is factual rather than
 * pedantic: at the moment of release the run is not terminal, it is `provisioning`, and calling it
 * terminal would put a state on the trail that the workflow row does not agree with. `forced` with
 * a null `released_by_user_id` is what the platform records when it takes a seat back itself, as
 * against an administrator seizing one — the same signature the FR-022 sweep leaves.
 *
 * The compare-and-set loser is deliberately **not** a release: that path means another start owns
 * this run, which is very much still going, and taking its identity away would be the worst kind of
 * fix.
 */

export const START_WORKFLOW_JOB_NAME = 'start-workflow'

/** Resume is its own job name, so the two show up separately in the job log (003/SC-007). */
export const RESUME_WORKFLOW_JOB_NAME = 'resume-workflow'

/** Everything provisioning needs that is not the workflow itself. */
export interface StartWorkflowDependencies {
  readonly db: SisyphusDatabase
  readonly compute: ComputeProvisioner
  /**
   * `SISYPHUS_MACHINE_SURFACE_URL` — the only URL the **envelope** carries.
   *
   * It was once the only URL the instance was told about at all. It no longer is: the executor
   * also reads `SISYPHUS_FORGE_API_URL`, the base of the code host's REST API. That one is
   * instance configuration rather than job configuration — it is identical for every run on a
   * stage — so it reaches the instance through its own environment and not through here, and
   * provisioning neither knows nor needs to know it.
   *
   * **That environment now has a producer, which it did not when the paragraph above was written**
   * (T238). `packages/sisyphus-infra/src/executor-instance-environment.ts` builds it and
   * `apps/sisyphus-executor/sst.config.ts` publishes it to
   * `/sisyphus/<stage>/executor/instance-environment` for the instance's launch unit to read, in
   * the same way and at the same path prefix as the executor release the unit fetches. The forge
   * URL is one entry in it, and a stage that has not supplied one fails that deploy naming the
   * variable. So the boundary this comment draws is unchanged and is now load-bearing in both
   * directions: the envelope carries job configuration, the published parameter carries instance
   * configuration, and neither restates the other.
   */
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
  /**
   * The agent credential named in the envelope, or `undefined` for a run admitted without a seat.
   *
   * Deliberately a different field from {@link StartedWorkflow.credentialId}, which is the
   * short-lived workflow-scoped JWT minted here. The two are unrelated things that share a word —
   * see `credentials/index.ts` — and one field carrying either would be the confusion that costs.
   */
  readonly agentCredentialId: string | undefined
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
  agentCredential: AgentCredentialReference | undefined,
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
    // Identifiers only (FR-012), and omitted entirely rather than carried as a null when the run
    // holds no seat — the same rule `resumeFromSnapshot` follows, and for the same reason: the
    // executor branches on the field's presence. T064 makes the absent case unreachable.
    ...(agentCredential === undefined ? {} : { agentCredential }),
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

  // Read from the live lease rather than carried down from admission: `start` can be reached by a
  // retried hand-off with nothing in hand but a workflow id, and a fence read from the lease cannot
  // disagree with the lease it describes.
  const agentCredential = await agentCredentialFor(db, workflowId)

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
      await assembleEnvelope(options, credential.token, agentCredential),
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

    // FR-021. The run reserved a seat at admission and is not going to use it; leaving it claimed
    // would strand it until the FR-039 sweep, twenty minutes of grace later, with nothing in the
    // meantime showing that a scarce identity was held by a run that never booted.
    const seat = await releaseLease({ db, workflowId, reason: 'forced' })

    await recordProvisioningPhase(
      db,
      workflowId,
      'failed',
      // The seat is named in the phase detail as well as in the audit trail, because this is the
      // record a person reads when they ask why a run failed to start — and "which identity did it
      // let go of" is the next question after "why".
      [
        thrown instanceof Error ? thrown.message : String(thrown),
        seat.outcome === 'released'
          ? `Released agent credential ${seat.agentCredentialId} (reason: ${seat.reason}); the credential is now ${seat.credentialState}.`
          : 'The run held no agent credential to release.',
      ].join(' '),
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
      agentCredentialId: agentCredential?.credentialId ?? null,
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
    agentCredentialId: agentCredential?.credentialId,
    userDataBytes,
  }
}

/**
 * **Resume (T096, T097, 003/FR-041, FR-043, FR-050) — start the same instance, or rebuild from the
 * snapshot; never anything in between.**
 *
 * ## The fast path is an absence of work
 *
 * FR-041 is written as three prohibitions — no re-provisioning, no re-cloning, no restoring — and
 * the implementation is those absences. {@link resumeWorkflow} calls `StartInstances` on the
 * instance id already on the run's live lease and stops. There is no launch, so no envelope is
 * assembled and no scoped credential is minted; there is no checkout, so the working tree is the
 * one the pause left; there is no restore, because the snapshot is a fallback rather than the
 * source. That is where SC-007's 5× comes from: a cold start pays for a launch, a bundle download,
 * a `setup.sh`, and a clone of every entry, and this pays for a boot.
 *
 * **`credential_install` still runs on this boot, and it must (FR-050).** Nothing here arranges
 * that and nothing here should: `apps/sisyphus-executor/src/run/bootstrap.ts` calls
 * `installAgentCredential` unconditionally between `setup_script` and `entry_checkout`, on every
 * boot there is, and `run/bootstrap.test.ts` asserts it for all three — a first boot, a restore
 * boot, and *"a resumed-instance boot, over material the previous boot left on the disk"*. That
 * last test is the one that matters here, and it is the reason there is no "already installed,
 * skip it" branch anywhere in the sequence: the seat's material can rotate while the instance is
 * stopped, so the file the previous boot wrote may be stale, and a resume that trusted it would
 * bring the run back up authenticated as nobody.
 *
 * ## The slow path is the FR-043 fallback, and it is reached two ways
 *
 * A stopped instance can refuse to start — no capacity of that family in that availability zone, or
 * a retirement the platform did not see. And a `spot` pause has no instance to start at all,
 * because it could not be stopped and was terminated instead (see `pause-instance.ts`). Both land
 * on {@link recoverOntoFreshInstance}, which provisions a fresh instance from the durable snapshot
 * **holding the same credential**, and records the substitution.
 *
 * "Holding the same credential" needs no code here, and that is the design working rather than an
 * omission. The run never released its seat — a pause is not terminal, so `releasesAgentCredential`
 * never answers true for it — so `agentCredentialFor` inside {@link startWorkflow} reads the same
 * live lease it read before the pause, and the fresh instance is handed the same identifiers. A
 * recovery that had to *re-acquire* a credential would be the bug FR-046 and SC-018 exist to
 * forbid: one workflow performed by two agents.
 *
 * ## A parked run resumes the same way, and the interesting part is what it does not do (T103,
 * FR-046)
 *
 * FR-046: *"Resuming a parked workflow MUST provision a fresh instance and MUST NOT wait for or
 * reserve a credential, because it never released the one it holds."* The first half is
 * {@link recoverOntoFreshInstance} again — a park released the instance and the disk, so there is
 * nothing to start and the snapshot is the only way back. The second half is the requirement, and
 * it is met by an **absence**: nothing on this path calls `acquireCredential`, nothing re-admits,
 * and nothing writes `awaiting_credential`. The run's seat is read with `agentCredentialFor` from
 * the live lease it has held since admission, exactly as the pause paths read it.
 *
 * That absence is worth stating because the plausible-looking alternative is a disaster. A parked
 * run is `parked_resumable`, which is a *terminal outcome*; a resume written as "re-admit it, it
 * has been terminal" would put it back in the credential queue behind runs that hold nothing, hand
 * it whichever seat came free, and produce one workflow performed end to end by two agents — the
 * single thing SC-018 forbids and this whole feature exists to prevent. `pause-instance.ts` keeps
 * the seat through the park precisely so this path has one to find.
 *
 * **A parked run that no longer holds a seat is refused rather than resumed.** That is not
 * defensive coding: FR-073 releases a parked run's credential when its snapshot passes the
 * retention period (`reconcile.ts`), and at that moment the run has genuinely ended. Resuming it
 * would mean acquiring a *different* identity, which FR-023 forbids outright — "a workflow MUST NOT
 * be moved to a different agent credential under any circumstance" — so the honest answer is that
 * this run cannot be resumed, said in those words, rather than a fresh instance running as somebody
 * else.
 */

/** The same instance was started again. No launch, no clone, no restore (FR-041). */
export interface StartedExistingInstance {
  readonly outcome: 'resumed'
  readonly path: 'started'
  readonly workflowId: string
  readonly instanceId: string
  /** The seat the run has held throughout, named so the resume is auditable against it. */
  readonly agentCredentialId: string | undefined
}

/** The instance was gone or would not start, so the run was rebuilt from its snapshot (FR-043). */
export interface RecoveredFromSnapshot {
  readonly outcome: 'resumed'
  readonly path: 'recovered'
  readonly workflowId: string
  /** The fresh instance. */
  readonly instanceId: string
  /** The instance it stands in for, where there was one left to name. */
  readonly replacedInstanceId: string | undefined
  readonly cause: SnapshotRecoveryCause
  readonly snapshotId: string
  /** **The same seat as before the pause** — the substitution is of the instance, never of this. */
  readonly agentCredentialId: string | undefined
}

/** The run is not in a state a resume may act on, or has nothing to be resumed from. */
export interface NotResumable {
  readonly outcome: 'not_resumable'
  readonly workflowId: string
  readonly state: Workflow['state']
  readonly reason: string
}

export type ResumeWorkflowOutcome = NotResumable | RecoveredFromSnapshot | StartedExistingInstance

export interface ResumeWorkflowOptions extends StartWorkflowDependencies {
  readonly workflowId: string
}

/**
 * Record that this run's environment was substituted, and start counting again (FR-043).
 *
 * A `resumed` row rather than a second `provisioned` one, because the substitution is a fact about
 * the *run's* continuity — the thing an engineer asks about when the instance id in their logs
 * changes halfway down. The fresh instance's own details are on the `provisioned` row
 * {@link startWorkflow} writes immediately after, and the two together are the whole record.
 */
const recordResume = async (options: {
  readonly db: SisyphusDatabase
  readonly workflowId: string
  readonly detail: Readonly<Record<string, unknown>>
}): Promise<void> => {
  await options.db.insert(workflowEvents).values({
    workflowId: options.workflowId,
    event: 'resumed',
    actorType: 'control_plane',
    detail: options.detail,
  })
}

/**
 * Provision a fresh instance from the run's durable snapshot, under the seat it still holds.
 *
 * The lease is re-taken here rather than in `admit-workflow.ts`, and deliberately: admission is
 * where a run competes for a *credential*, and this run already has one. Re-admitting would put it
 * back into a queue for something it never let go of, behind runs that hold nothing — which is
 * FR-046's point, made a phase early because the same reasoning applies to a paused run as to a
 * parked one.
 *
 * @param options - The provisioning dependencies and the run.
 * @param substitution - What is being replaced, and why.
 */
const recoverOntoFreshInstance = async (
  options: ResumeWorkflowOptions,
  substitution: {
    readonly cause: SnapshotRecoveryCause
    readonly replacedInstanceId: string | undefined
    readonly snapshot: ResumableSnapshot
    readonly state: Workflow['state']
  },
): Promise<ResumeWorkflowOutcome> => {
  const { db, workflowId } = options
  const now = options.now ?? ((): Date => new Date())

  const workflow = firstRow(
    await db
      .select({ instanceType: workflows.instanceType, purchaseMode: workflows.purchaseMode })
      .from(workflows)
      .where(eq(workflows.id, workflowId))
      .limit(1),
  )

  if (workflow === undefined) {
    throw new Error(`Workflow ${workflowId} does not exist, so there is nothing to recover.`)
  }

  // Reuse a live lease that names no instance — a previous recovery that failed at the launch —
  // rather than inserting a second one, which `compute_leases_live_key` would refuse anyway.
  const existing = firstRow(
    await db
      .select({ id: computeLeases.id })
      .from(computeLeases)
      .where(and(eq(computeLeases.workflowId, workflowId), isNull(computeLeases.releasedAt)))
      .limit(1),
  )

  if (existing === undefined) {
    await db.insert(computeLeases).values({
      workflowId,
      // Off the write-once job spec, exactly as admission takes it. A recovery must not quietly
      // re-price or re-size a run because its first instance went away (FR-149).
      instanceType: workflow.instanceType,
      purchaseMode: workflow.purchaseMode,
      requestedAt: now(),
    })
  }

  // Before the launch, so the run is never `paused` with an instance booting under it — and so the
  // idle clock `reconcile.ts` reads off the `paused` timeline row stops counting towards a park.
  //
  // The terminal outcome is cleared in the same statement, which matters only for the parked case
  // and matters a great deal there: a park writes `terminal_outcome = 'parked_resumable'`, and a
  // run that came back `provisioning` while still carrying it would have two accounts of itself in
  // one row, which is the exact ambiguity FR-064's "exactly one outcome in force" forbids. For a
  // paused run both columns are already null and this is a no-op.
  await db
    .update(workflows)
    .set({ state: 'provisioning', terminalOutcome: null, outcomeReason: null })
    .where(eq(workflows.id, workflowId))

  const started = await startWorkflow(options)

  if (started.outcome !== 'started') {
    return {
      outcome: 'not_resumable',
      workflowId,
      state: substitution.state,
      reason: `The recovery launch did not produce an instance (${started.outcome}). The run keeps its seat and its snapshot, so a later attempt resumes from exactly here.`,
    }
  }

  await recordResume({
    db,
    workflowId,
    detail: {
      path: 'recovered_from_snapshot',
      cause: substitution.cause,
      replacedInstanceId: substitution.replacedInstanceId ?? null,
      instanceId: started.instanceId,
      snapshotId: substitution.snapshot.id,
      // Named on the substitution record because "did it come back as the same agent" is the first
      // question worth asking about a substituted environment (FR-043, SC-018).
      agentCredentialId: started.agentCredentialId ?? null,
    },
  })

  return {
    outcome: 'resumed',
    path: 'recovered',
    workflowId,
    instanceId: started.instanceId,
    replacedInstanceId: substitution.replacedInstanceId,
    cause: substitution.cause,
    snapshotId: substitution.snapshot.id,
    agentCredentialId: started.agentCredentialId,
  }
}

/**
 * Bring one paused or parked run back (FR-041, FR-043, FR-046).
 *
 * @param options - The provisioning dependencies and the run.
 * @returns Which of the three things happened. Only `resumed` touched an instance.
 * @throws If the workflow does not exist.
 */
export const resumeWorkflow = async (
  options: ResumeWorkflowOptions,
): Promise<ResumeWorkflowOutcome> => {
  const { compute, db, workflowId } = options

  const workflow = firstRow(
    await db
      .select({ state: workflows.state })
      .from(workflows)
      .where(eq(workflows.id, workflowId))
      .limit(1),
  )

  if (workflow === undefined) {
    throw new Error(`Workflow ${workflowId} does not exist, so there is no run to resume.`)
  }

  const parked = workflow.state === 'parked_resumable'

  if (workflow.state !== 'paused' && !parked) {
    return {
      outcome: 'not_resumable',
      workflowId,
      state: workflow.state,
      reason: 'Only a paused or parked run has an environment to start or to rebuild.',
    }
  }

  const snapshot = await resumableSnapshotFor(db, workflowId)

  if (snapshot === undefined) {
    // Refused rather than started, and this is not over-caution: without a snapshot, a start that
    // fails leaves the run with nothing at all, and the whole point of taking one before the stop
    // (FR-039) was to make that impossible. For a parked run it is not even a precaution — the
    // snapshot is the only thing left, so an unresumable one means there is nothing to resume.
    return {
      outcome: 'not_resumable',
      workflowId,
      state: workflow.state,
      reason: parked
        ? 'The run was parked and its current snapshot no longer carries both conversation and worktree state, so there is nothing left to rebuild it from. A park releases the instance and the disk (003/FR-044), which makes the snapshot the whole of the run.'
        : 'The run has no current snapshot carrying both conversation and worktree state, so a failed start would leave nothing to fall back to (003/FR-039, FR-043).',
    }
  }

  if (parked) {
    // FR-046, in three lines and one absence. There is no instance to start — the park released it
    // along with the disk — so this goes straight to the rebuild, and it goes there **without
    // touching the acquire path**: no `acquireCredential`, no re-admission, no `awaiting_credential`.
    // The seat is the one the run has held since admission, read below by `startWorkflow` from the
    // same live lease this check reads.
    const seat = await agentCredentialFor(db, workflowId)

    if (seat === undefined) {
      // The park has become terminal in fact: `reconcile.ts` hands a parked run's seat back once
      // its snapshot passes the retention period (FR-073). Reserving another one is the one thing
      // FR-023 forbids without qualification, so the run ends here rather than coming back as
      // somebody else.
      return {
        outcome: 'not_resumable',
        workflowId,
        state: workflow.state,
        reason:
          'The run was parked and no longer holds an agent credential — its seat was handed back when its snapshot passed the retention period. Resuming would mean running it under a different identity, which is forbidden outright: a workflow is performed end to end by exactly one agent credential (003/FR-023, FR-073, SC-018).',
      }
    }

    return recoverOntoFreshInstance(options, {
      cause: 'parked_past_idle_limit',
      // Nothing to name: the park terminated the instance and released the compute lease that
      // recorded it, which is what "released instance, released disk" means (FR-044).
      replacedInstanceId: undefined,
      snapshot,
      state: workflow.state,
    })
  }

  const lease = firstRow(
    await db
      .select({ providerInstanceId: computeLeases.providerInstanceId })
      .from(computeLeases)
      .where(and(eq(computeLeases.workflowId, workflowId), isNull(computeLeases.releasedAt)))
      .limit(1),
  )

  if (lease?.providerInstanceId == null) {
    // No instance to start. A `spot` pause left the run here on purpose — see `pause-instance.ts`
    // — and it arrives at exactly the same recovery an on-demand failure does.
    return recoverOntoFreshInstance(options, {
      cause: 'spot_cannot_stop',
      replacedInstanceId: undefined,
      snapshot,
      state: workflow.state,
    })
  }

  const instanceId = lease.providerInstanceId

  try {
    await compute.start({ instanceId })
  } catch {
    // FR-043, the case it was written for. Give the stranded instance and its disk up through the
    // same function the spot pause calls, then rebuild — one recovery, two ways in.
    const given = await giveUpEnvironment({
      db,
      compute,
      workflowId,
      cause: 'instance_would_not_start',
      ...(options.now === undefined ? {} : { now: options.now }),
    })

    if (given.outcome === 'refused') {
      return { outcome: 'not_resumable', workflowId, state: workflow.state, reason: given.reason }
    }

    return recoverOntoFreshInstance(options, {
      cause: 'instance_would_not_start',
      replacedInstanceId: instanceId,
      snapshot,
      state: workflow.state,
    })
  }

  const agentCredential = await agentCredentialFor(db, workflowId)

  // The lease is untouched: same row, same instance id, same `ready_at`. FR-041's "without
  // re-provisioning" is this — there is nothing new to record, because nothing new exists.
  await db.update(workflows).set({ state: 'provisioning' }).where(eq(workflows.id, workflowId))

  await recordResume({
    db,
    workflowId,
    detail: {
      path: 'started_existing_instance',
      instanceId,
      agentCredentialId: agentCredential?.credentialId ?? null,
    },
  })

  return {
    outcome: 'resumed',
    path: 'started',
    workflowId,
    instanceId,
    agentCredentialId: agentCredential?.credentialId,
  }
}

/** Resume wrapped in the uniform job envelope. */
export const runResumeWorkflow = (
  options: ResumeWorkflowOptions,
): Promise<JobOutcome<ResumeWorkflowOutcome>> =>
  runJob(RESUME_WORKFLOW_JOB_NAME, () => resumeWorkflow(options))

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
