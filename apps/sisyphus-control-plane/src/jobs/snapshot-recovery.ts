import type { SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'
import {
  computeLeases,
  credentialLeases,
  sessionSnapshots,
  workflows,
} from '@bluetel-ai/sisyphus-api/db'
import { and, eq, isNull } from 'drizzle-orm'

import type { ComputeProvisioner } from '../aws'

/**
 * **The FR-043 fallback — one way to give an execution environment up, for every reason there is
 * to give one up (T095, T097).**
 *
 * 003/FR-043 asks for one thing: when a stopped instance cannot be started again, the run is
 * recovered from its durable snapshot onto a fresh instance **holding the same credential**, and
 * the substitution is recorded. That reads like a rare corner. It is not — it is the *ordinary*
 * path for the majority of runs, and understanding why is the whole reason this module exists
 * rather than a branch inside `pause-instance.ts`.
 *
 * ## Why spot pauses arrive here rather than getting a path of their own (research R6)
 *
 * `spot` is the platform default (`DEFAULT_PURCHASE_MODE`), and **a one-time spot instance cannot
 * be stopped by its owner at all**. So FR-039's "stop the instance and keep the disk" is
 * unachievable for most runs under current defaults, and a spot pause has to degrade to 002's
 * behaviour: snapshot, terminate, and resume from the snapshot onto a fresh instance.
 *
 * That degraded behaviour is, line for line, what FR-043 already requires for a stopped on-demand
 * instance that refuses to start. Writing it twice would produce two implementations of the same
 * recovery, and — this is the part that matters — the *spot* one would be the one that ran, on
 * every pause of every default-configured run, while the FR-043 one ran approximately never and
 * rotted. The rare path must be the common path, or it is not a path at all: it is code that will
 * be wrong the first time it is needed, at the worst moment, on somebody's stopped instance.
 *
 * So there is one implementation, reached by four causes ({@link SNAPSHOT_RECOVERY_CAUSES}), and
 * the spot pause is the one that keeps it exercised.
 *
 * ## The fourth cause is not a failure at all (T101, 003/FR-044)
 *
 * `parked_past_idle_limit` is a *pause that outlived its idle limit*, and FR-044 asks for exactly
 * what this function already does: released instance, released disk, work preserved durably. It
 * arrives here rather than growing a park path of its own for the same reason the spot pause does —
 * a second implementation of "terminate and stand on the snapshot" is a second implementation to
 * keep correct — and because the two really are the same act. What differs is what the *caller*
 * does afterwards: a spot pause leaves the run `paused` and a park moves it to `parked_resumable`,
 * and that difference belongs in `pause-instance.ts`, where the run's state is decided, rather than
 * here, where an environment is destroyed.
 *
 * That this module does not touch `credential_leases` is what makes the park correct as well as the
 * pause: FR-073 has a parked workflow **retaining** its agent credential, and a park that reached a
 * function which released one would be SC-018's forbidden case — one workflow, two identities —
 * arriving through the cheapest possible edit.
 *
 * ## What "give the environment up" means, and what it deliberately does not touch
 *
 * {@link giveUpEnvironment} terminates the instance, releases the **compute** lease with the cause
 * recorded on it, and stops there. It does not touch `credential_leases`, and that is not an
 * omission to be tidied up later — it is 003/FR-040 and FR-018 as executable code:
 *
 * - a paused workflow retains its agent credential (FR-040), and a pause that reached this module
 *   is still a pause;
 * - a lease belongs to the **workflow**, not to any instance (FR-018), so an environment being
 *   destroyed, reclaimed or rebuilt says nothing at all about who holds the seat.
 *
 * `agent-credential-release.ts` is where the platform decides that a run has given its seat up, it
 * decides it from the run's *state*, and nothing here changes a run's state. The credential id is
 * nevertheless read back and returned, so a caller can report which seat survived — and so the
 * tests can assert the survival rather than argue it.
 *
 * ## Refusing is a legitimate answer
 *
 * {@link giveUpEnvironment} will not destroy anything for a run whose durable snapshot is missing
 * or incomplete. An instance is recoverable while it exists; once terminated, a run whose snapshot
 * lacks conversation or worktree state is unrecoverable, and the difference between "we gave your
 * instance back" and "we lost your work" is exactly this check. The cost of refusing is a running
 * instance that goes on billing until somebody looks, which is the cheaper of the two mistakes by
 * a wide margin — the same trade `teardown-workflow.ts` makes when it confirms durability before it
 * destroys anything.
 */

/**
 * Why an execution environment was given up in favour of its durable snapshot.
 *
 * Four causes, one path. They are recorded rather than collapsed because they answer different
 * operational questions: `spot_cannot_stop` is the expected cost of the default purchase mode and
 * should be the overwhelming majority; `parked_past_idle_limit` is the platform doing what FR-044
 * asks of a forgotten pause and is a fact about *people*, not about capacity; and the other two are
 * *incidents*, where a rise in either is a capacity problem in a particular instance family or
 * availability zone. A single "recovered from snapshot" counter would hide those distinctions
 * behind a number that always looked bad.
 */
export const SNAPSHOT_RECOVERY_CAUSES = [
  /** A one-time spot instance cannot be stopped, so the pause degrades to 002's path (R6). */
  'spot_cannot_stop',
  /** `StartInstances` refused, so the stopped instance is not coming back (FR-043). */
  'instance_would_not_start',
  /** `StopInstances` refused, so the instance cannot be paused cheaply and is given up instead. */
  'instance_would_not_stop',
  /**
   * The pause outlived the idle limit, so the run is parked: instance and disk released, seat kept
   * (FR-044, FR-073). The only cause that is a deliberate policy rather than a thing going wrong.
   */
  'parked_past_idle_limit',
] as const

export type SnapshotRecoveryCause = (typeof SNAPSHOT_RECOVERY_CAUSES)[number]

/** Prose for the cause, written where a person reads it: the lease's `release_reason`. */
const CAUSE_REASONS: Readonly<Record<SnapshotRecoveryCause, string>> = {
  spot_cannot_stop:
    'paused on interruptible capacity, which cannot be stopped; the instance was released and the run resumes from its durable snapshot (003/FR-039, R6)',
  instance_would_not_start:
    'the stopped instance could not be started again; the run resumes from its durable snapshot onto a fresh instance holding the same credential (003/FR-043)',
  instance_would_not_stop:
    'the instance could not be stopped, so it was released rather than left billing; the run resumes from its durable snapshot (003/FR-043)',
  parked_past_idle_limit:
    'the pause outlived the idle limit, so the run was parked: its instance and its disk were released and it stands on its durable snapshot, holding its agent credential, until somebody resumes it (003/FR-044, FR-073)',
}

/** The snapshot a resume would be built from, once it is one that could actually be built from. */
export interface ResumableSnapshot {
  readonly id: string
  readonly s3Key: string
  /** The session the snapshot was taken of — not the run's own id (002/FR-150). */
  readonly sessionId: string
}

/** See `admit-workflow.ts`: `noUncheckedIndexedAccess` is off, so indexing needs an honest type. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/**
 * The run's current snapshot, if it is one a resume could be built from.
 *
 * Both state flags are required, because 002/FR-050 makes them the definition of resumable: an
 * archive with a working tree and no conversation resumes into an agent that has forgotten what it
 * was doing, and one with a conversation and no working tree resumes into an agent whose edits are
 * gone. Either is worse than not resuming, because both look like success.
 *
 * @param db - The handle.
 * @param workflowId - The run.
 * @returns `undefined` when there is no current snapshot or when it is not resumable.
 */
export const resumableSnapshotFor = async (
  db: Pick<SisyphusDatabase, 'select'>,
  workflowId: string,
): Promise<ResumableSnapshot | undefined> => {
  const snapshot = firstRow(
    await db
      .select({
        id: sessionSnapshots.id,
        s3Key: sessionSnapshots.s3Key,
        sessionId: sessionSnapshots.sessionId,
        hasConversationState: sessionSnapshots.hasConversationState,
        hasWorktreeState: sessionSnapshots.hasWorktreeState,
      })
      .from(sessionSnapshots)
      .innerJoin(workflows, eq(workflows.currentSnapshotId, sessionSnapshots.id))
      .where(eq(workflows.id, workflowId))
      .limit(1),
  )

  if (snapshot === undefined || !snapshot.hasConversationState || !snapshot.hasWorktreeState) {
    return undefined
  }

  return { id: snapshot.id, s3Key: snapshot.s3Key, sessionId: snapshot.sessionId }
}

/** The environment is gone and the run stands on its snapshot. The seat is untouched. */
export interface GivenUpEnvironment {
  readonly outcome: 'given_up'
  readonly workflowId: string
  readonly cause: SnapshotRecoveryCause
  /** Undefined when the lease named no instance — a launch that never got that far. */
  readonly terminatedInstanceId: string | undefined
  /** Undefined when there was no live lease left to release. */
  readonly releasedLeaseId: string | undefined
  /** What a resume will be rebuilt from. */
  readonly snapshot: ResumableSnapshot
  /**
   * The seat the run **still holds** (FR-040, FR-018).
   *
   * Reported so the caller can say so, and so a test can assert it against the same row the
   * platform would read. `undefined` only for a run that was never granted one.
   */
  readonly agentCredentialId: string | undefined
}

/** Nothing was destroyed, because destroying it would have made the run unrecoverable. */
export interface RefusedGiveUp {
  readonly outcome: 'refused'
  readonly workflowId: string
  readonly cause: SnapshotRecoveryCause
  readonly reason: string
}

export type GiveUpOutcome = GivenUpEnvironment | RefusedGiveUp

export interface GiveUpEnvironmentOptions {
  readonly db: SisyphusDatabase
  readonly compute: ComputeProvisioner
  readonly workflowId: string
  readonly cause: SnapshotRecoveryCause
  /** Injectable clock, so the recorded release instant is data rather than timing. */
  readonly now?: () => Date
}

/**
 * Hand the run's execution environment back, leaving it resumable from its durable snapshot.
 *
 * Terminate, then release the lease — the order `teardown-workflow.ts` uses and for the same
 * reason: the lease is the platform's record that an instance exists, so releasing it before the
 * instance is actually gone would hide a failed termination from the very sweep that would
 * otherwise catch it.
 *
 * @param options - The handles, the run, and why the environment is being given up.
 * @returns What happened. `refused` destroyed nothing.
 */
export const giveUpEnvironment = async (
  options: GiveUpEnvironmentOptions,
): Promise<GiveUpOutcome> => {
  const { cause, compute, db, workflowId } = options
  const now = (options.now ?? ((): Date => new Date()))()

  const snapshot = await resumableSnapshotFor(db, workflowId)

  if (snapshot === undefined) {
    return {
      outcome: 'refused',
      workflowId,
      cause,
      reason:
        'The run has no durable snapshot carrying both conversation and worktree state, so releasing its instance would leave nothing to resume from. The instance is left running — and billing — because an unrecoverable run is indistinguishable from lost work (003/FR-043, 002/FR-050).',
    }
  }

  const lease = firstRow(
    await db
      .select({ id: computeLeases.id, providerInstanceId: computeLeases.providerInstanceId })
      .from(computeLeases)
      .where(and(eq(computeLeases.workflowId, workflowId), isNull(computeLeases.releasedAt)))
      .limit(1),
  )

  if (lease?.providerInstanceId != null) {
    await compute.terminate({ instanceId: lease.providerInstanceId })
  }

  if (lease !== undefined) {
    await db
      .update(computeLeases)
      .set({ releasedAt: now, releaseReason: CAUSE_REASONS[cause] })
      .where(and(eq(computeLeases.id, lease.id), isNull(computeLeases.releasedAt)))
  }

  // Read, never written. See the module note: the seat belongs to the workflow and this module has
  // no business having an opinion about it — it reports it so the caller does not have to guess.
  const seat = firstRow(
    await db
      .select({ agentCredentialId: credentialLeases.agentCredentialId })
      .from(credentialLeases)
      .where(and(eq(credentialLeases.workflowId, workflowId), isNull(credentialLeases.releasedAt)))
      .limit(1),
  )

  return {
    outcome: 'given_up',
    workflowId,
    cause,
    terminatedInstanceId: lease?.providerInstanceId ?? undefined,
    releasedLeaseId: lease?.id,
    snapshot,
    agentCredentialId: seat?.agentCredentialId,
  }
}
