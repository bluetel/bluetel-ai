import type { ComputeLease, SisyphusDatabase, Workflow } from '@bluetel-ai/sisyphus-api/db'
import {
  computeLeases,
  credentialLeases,
  workflowEvents,
  workflows,
} from '@bluetel-ai/sisyphus-api/db'
import { and, desc, eq, isNull } from 'drizzle-orm'

import type { AttachedVolume, ComputeProvisioner } from '../aws'

import { PAUSE_IDLE_CEILING_MS } from './reconcile'
import type { JobOutcome } from './run-job'
import { runJob, toError } from './run-job'
import type { GivenUpEnvironment, SnapshotRecoveryCause } from './snapshot-recovery'
import { giveUpEnvironment, resumableSnapshotFor } from './snapshot-recovery'

/**
 * **Pause (T094, T095, 003/FR-039, FR-040, FR-042) — stop the instance, keep the disk, keep the
 * seat.**
 *
 * 002 paused a run by holding its agent process alive on a running instance (`002/FR-049`). That
 * made a resume instant and made a pause cost the same as running, which is why pauses were
 * something people avoided using. 003/FR-039 supersedes it: the agent is brought to a turn
 * boundary, a durable snapshot is captured, and **then the instance is stopped** with its disk
 * intact. Compute billing ends; storage billing does not (FR-042); the working tree, the
 * conversation and the seat are all exactly where they were.
 *
 * ## Two purchase modes, one code path — and the spot one is not a second implementation
 *
 * `spot` is the platform default and **a one-time spot instance cannot be stopped at all**. So
 * FR-039 as written is unachievable for most runs, and a spot pause degrades to 002's
 * snapshot-and-terminate. The temptation is to write that as a branch here: terminate, release,
 * mark it, done. That branch would be about fifteen lines and it would be a mistake.
 *
 * It would be a mistake because those fifteen lines are the same fifteen lines FR-043 already
 * requires for a *stopped instance that will not start again*, and of the two, the FR-043 copy
 * would run approximately never. The path that runs on every pause of every default-configured run
 * would be one implementation, and the path that runs when somebody's stopped instance is stranded
 * would be another, untested one. So the spot branch calls {@link giveUpEnvironment} in
 * `snapshot-recovery.ts` — the same function the failed-start path calls, with a different
 * {@link SnapshotRecoveryCause} — and a spot pause and a failed on-demand start converge, by
 * construction, on identical behaviour. `pause-instance.test.ts` asserts that convergence directly
 * rather than trusting this paragraph.
 *
 * ## Neither mode releases the seat (FR-040, FR-073)
 *
 * Nothing in this file writes to `credential_leases`, and nothing it calls does either. A pause
 * leaves the run `paused`, which is not terminal, so `agent-credential-release.ts` — the single
 * expression of "terminal, but not merely parked" — never answers true for it, and
 * `teardown-workflow.ts` returns `not_terminal` before it reaches a release. The seat is read back
 * and reported on both paths so the fact is legible in the outcome, and asserted on both paths in
 * the suite, because "the credential survives a pause" is the claim the whole feature rests on and
 * it must not be true only on the branch somebody happened to test.
 *
 * ## The durable snapshot is a precondition, on **both** paths
 *
 * FR-039 orders it that way — turn boundary, snapshot, *then* stop — and the ordering is not
 * decoration. For spot it is obvious: the terminate is irreversible and the snapshot is all that
 * survives it. For on-demand it is subtler and just as real: a stopped instance can fail to start
 * again (FR-043), and at that moment the only thing standing between the run and lost work is the
 * snapshot taken before the stop. A pause that stopped an instance without one would be betting the
 * run on the instance coming back.
 *
 * The turn boundary itself is the executor's to reach, and the platform's record that it did is the
 * acknowledged `paused` state (`packages/sisyphus-api/src/server/workflow/supervision.ts` moves the
 * run there only on an `acknowledged` outcome, and the executor only acknowledges after
 * `suspend()` has quiesced, captured and registered). So this job requires the run to be `paused`
 * rather than re-deriving a boundary it has no way to observe.
 *
 * ## Which path a pause took is recorded, because SC-007 is two numbers
 *
 * SC-007 asks for a resumed on-demand pause to reach its first turn 5× faster than a cold start,
 * and explicitly holds spot to 002's resume performance instead — "the two MUST be measured and
 * reported as separate figures, because a single blended number would misrepresent both". A
 * measurement that cannot tell which path a pause took cannot produce two figures.
 *
 * So {@link recordPausePath} writes the path onto the run's `paused` timeline row. **It merges into
 * the existing row rather than appending a new one**, and that is load-bearing rather than tidy:
 * `jobs/reconcile.ts` reads the latest `paused` event's `created_at` as the instant the pause began
 * — there is no `workflows.paused_at` column — and a second `paused` row written here would reset
 * that clock on every pause, so a run could never reach the idle limit that parks it (FR-044). One
 * pause is one event; this job learns something about it a moment after it was written.
 *
 * ## Past the idle limit, a pause is no longer a pause: it parks (T101, T102, FR-044, FR-045)
 *
 * A pause is a bet that somebody is coming back. Everything above is arranged around that bet
 * paying off — the disk is kept, the instance id stays on the lease, the seat is held — and every
 * one of those is a cost carried on behalf of a person who has, most of the time, gone to lunch.
 * Past {@link PAUSE_IDLE_CEILING_MS} the bet is called: {@link parkRun} gives the environment up
 * through the same {@link giveUpEnvironment} the spot path uses, so the **instance and the disk both
 * go**, and moves the run to `parked_resumable` — FR-044's "reported as parked rather than failed",
 * which matters because the two words mean opposite things to the person who left it. Failed says
 * their work is gone. Parked says it is on a shelf, and `start-workflow.ts` will take it down.
 *
 * **The seat is deliberately not released** (FR-073). A parked run consumes an agent identity while
 * consuming no compute at all, which is a strange-looking trade and the right one: the alternative
 * is resuming somebody's work under a different agent, which is the single thing SC-018 forbids.
 * Nothing in this file writes to `credential_leases` on any path, park included, and the pool view
 * reports the resulting holders as `parked` so the trade is visible rather than mysterious.
 *
 * **The one thing a park will not do is release an environment it could not rebuild the run from**
 * (FR-045). That is the same `resumableSnapshotFor` precondition every other path here observes,
 * and it is stated once, above the branch, precisely so a park cannot acquire an exception to it.
 * The cost priority inverts here and does so knowingly: a refused park leaves an instance billing,
 * and an unresumable park is indistinguishable from having deleted somebody's work.
 *
 * **A run whose pause the timeline never recorded is never parked here.** There is no evidence of
 * when its pause began, and acting without evidence is how a pause taken thirty seconds ago gets
 * parked — the same rule `reconcile.ts` applies to the same absence, for the same reason.
 */

export const PAUSE_INSTANCE_JOB_NAME = 'pause-instance'

/**
 * How a pause was taken.
 *
 * `stopped` is FR-039 as written. `snapshot_recovery` is FR-039 degraded through the FR-043
 * fallback — the instance is gone and the run stands on its snapshot.
 */
export type PausePath = 'snapshot_recovery' | 'stopped'

/**
 * The queue drain (T051), called after a lease is released and never before.
 *
 * Only the `snapshot_recovery` and `parked` paths release a compute lease, so only those two drain.
 * A stop releases nothing — the instance is still the run's, merely off — so there is no freed slot
 * to fill and draining would be a no-op that implied otherwise.
 *
 * Note that a park frees a *compute* slot and no seat at all (FR-073), so the drain it triggers may
 * admit a run waiting under the concurrency ceiling and cannot admit one waiting for a credential.
 * That asymmetry is the point of parking rather than an oversight in it.
 */
export interface QueueDrain {
  readonly drain: () => Promise<void>
}

export interface PauseInstanceOptions {
  readonly db: SisyphusDatabase
  readonly compute: ComputeProvisioner
  readonly workflowId: string
  /** Run after a path that releases a lease, so the freed slot is re-admitted. */
  readonly queueDrain?: QueueDrain
  /** Injectable clock, so recorded instants are data rather than timing. */
  readonly now?: () => Date
  /**
   * How long a pause may last before it parks (FR-044).
   *
   * Defaults to {@link PAUSE_IDLE_CEILING_MS}, which is imported from `reconcile.ts` rather than
   * restated: the sweep is the backstop for the case where this job never ran, and a backstop
   * working to a different number from the thing it backs up is two behaviours wearing one name.
   * Passed in for the same reason every other threshold in this directory is — a job does not read
   * its own configuration, and a suite must be able to state the limit it is testing.
   */
  readonly pauseIdleCeilingMs?: number
}

/** The instance is stopped and its disk is still attached (FR-039). */
export interface StoppedPause {
  readonly outcome: 'paused'
  readonly path: 'stopped'
  readonly workflowId: string
  readonly purchaseMode: ComputeLease['purchaseMode']
  readonly instanceId: string
  /**
   * The volumes still attached **after** the stop, as EC2 reported them.
   *
   * Observed rather than assumed: a pause that said "the disk is retained" without asking would be
   * reporting its own intention. See `aws/compute.ts`.
   */
  readonly retainedVolumes: readonly AttachedVolume[]
  /** Still held (FR-040). Undefined only for a run that was never granted one. */
  readonly agentCredentialId: string | undefined
}

/** The instance was given up and the run stands on its snapshot (FR-039 via FR-043). */
export interface RecoverablePause {
  readonly outcome: 'paused'
  readonly path: 'snapshot_recovery'
  readonly workflowId: string
  readonly purchaseMode: ComputeLease['purchaseMode']
  readonly cause: SnapshotRecoveryCause
  readonly terminatedInstanceId: string | undefined
  readonly snapshotId: string
  /** Still held (FR-040) — the environment went, the seat did not (FR-018). */
  readonly agentCredentialId: string | undefined
  /** The drain ran and threw. Reported rather than raised: the lease is already released. */
  readonly queueDrainError: Error | undefined
}

/** The run is not in a state a pause may act on. */
export interface NotPausable {
  readonly outcome: 'not_pausable'
  readonly workflowId: string
  readonly state: Workflow['state']
  readonly reason: string
}

/** There is no live lease, or it names no instance. Nothing to stop; nothing to give up. */
export interface NoInstanceToPause {
  readonly outcome: 'no_instance'
  readonly workflowId: string
  readonly agentCredentialId: string | undefined
}

/** The run has no snapshot worth stopping an instance behind. Nothing was touched. */
export interface RefusedPause {
  readonly outcome: 'refused'
  readonly workflowId: string
  readonly reason: string
}

/**
 * The pause outlived the idle limit: instance and disk released, work durable, seat kept (FR-044).
 *
 * Its own outcome rather than a flag on {@link RecoverablePause}, because it is a different event
 * with a different consequence — the run is terminal now, in the `parked_resumable` sense that
 * `agent-credential-release.ts` exists to qualify — and a caller that treated a park as a pause
 * would go on waiting for a resume nobody has asked for.
 */
export interface ParkedRun {
  readonly outcome: 'parked'
  readonly workflowId: string
  /** The instance the park destroyed, or `undefined` where an earlier pause had already given it up. */
  readonly releasedInstanceId: string | undefined
  /** What a resume will be rebuilt from — confirmed resumable before anything was released. */
  readonly snapshotId: string
  /** How long the run had been paused, so the decision can be audited against the limit in force. */
  readonly pausedForMs: number
  /**
   * **Still held** (FR-073), and the reason this field is on the outcome at all.
   *
   * A park releases the run's compute and keeps its identity, which is the least intuitive rule in
   * the feature; reporting the seat here is what lets a caller — and the suite — state it as a fact
   * read back from the lease table rather than as an intention.
   */
  readonly agentCredentialId: string | undefined
  /** The drain ran and threw. Reported rather than raised: the compute lease is already released. */
  readonly queueDrainError: Error | undefined
}

export type PauseInstanceOutcome =
  | NoInstanceToPause
  | NotPausable
  | ParkedRun
  | RecoverablePause
  | RefusedPause
  | StoppedPause

/** See `admit-workflow.ts`: `noUncheckedIndexedAccess` is off, so indexing needs an honest type. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/**
 * The run's newest `paused` timeline row — when the current pause began, and what was said about it.
 *
 * One reader for two questions, because they are the same row and reading it twice is how the two
 * come to disagree: {@link recordPausePath} merges into it, and the idle-limit check measures from
 * its `created_at`. That column is the platform's only record of when a pause started — there is no
 * `workflows.paused_at` — and `reconcile.ts` reads exactly the same one, which is what makes this
 * job and the sweep that backs it up agree about which pauses have gone on too long.
 *
 * @param db - The handle.
 * @param workflowId - The run.
 * @returns `undefined` for a pause the timeline never recorded. Both callers treat that as "no
 *   evidence" rather than as zero.
 */
const latestPausedEvent = async (
  db: Pick<SisyphusDatabase, 'select'>,
  workflowId: string,
): Promise<
  { readonly id: string; readonly detail: unknown; readonly createdAt: Date } | undefined
> =>
  firstRow(
    await db
      .select({
        id: workflowEvents.id,
        detail: workflowEvents.detail,
        createdAt: workflowEvents.createdAt,
      })
      .from(workflowEvents)
      .where(and(eq(workflowEvents.workflowId, workflowId), eq(workflowEvents.event, 'paused')))
      // Latest wins: a run may have been paused, resumed and paused again, and it is the current
      // pause that both the merge and the clock are about.
      .orderBy(desc(workflowEvents.createdAt), desc(workflowEvents.id))
      .limit(1),
  )

/**
 * Write which path this pause took onto the run's `paused` timeline row (SC-007).
 *
 * Merged into the newest such row rather than appended as a new one — see the module note: a second
 * `paused` row would move the clock `reconcile.ts` reads as "when this pause began", and a pause
 * whose clock keeps restarting never reaches the idle limit that parks it.
 *
 * A run with no `paused` row at all gets one written here. That case means the pause predates the
 * timeline — `reconcile.ts` deliberately leaves such runs alone, so they would otherwise sit
 * unclocked for ever — and starting the clock now is strictly better than never starting it.
 *
 * @param options - The handle, the run, and what to record about the pause.
 */
const recordPausePath = async (options: {
  readonly db: SisyphusDatabase
  readonly workflowId: string
  readonly detail: Readonly<Record<string, unknown>>
}): Promise<void> => {
  const { db, detail, workflowId } = options

  const existing = await latestPausedEvent(db, workflowId)

  if (existing === undefined) {
    await db.insert(workflowEvents).values({
      workflowId,
      event: 'paused',
      actorType: 'control_plane',
      detail,
    })
    return
  }

  await db
    .update(workflowEvents)
    .set({
      // Spread first, so what the executor recorded about its own pause — the command id it was
      // answering — survives alongside what the platform did about it.
      detail: { ...(existing.detail as Record<string, unknown> | null), ...detail },
    })
    .where(eq(workflowEvents.id, existing.id))
}

/** The seat the run holds, read for reporting and never for changing (FR-040). */
const seatHeldBy = async (
  db: Pick<SisyphusDatabase, 'select'>,
  workflowId: string,
): Promise<string | undefined> =>
  firstRow(
    await db
      .select({ agentCredentialId: credentialLeases.agentCredentialId })
      .from(credentialLeases)
      .where(and(eq(credentialLeases.workflowId, workflowId), isNull(credentialLeases.releasedAt)))
      .limit(1),
  )?.agentCredentialId

/**
 * Run the drain, if one was supplied, and report rather than raise.
 *
 * The lease is already released by the time this is called, so a drain failure must not turn a
 * completed pause into a job failure something will retry against a lease it has itself released.
 * The same rule `teardown-workflow.ts` follows, for the same reason.
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
 * Take one paused run's instance out of billing (FR-039), or park the run outright (FR-044).
 *
 * @param options - The handles, the run, and the idle limit in force.
 * @returns Which of the six things happened. Only `paused` and `parked` changed anything about the
 *   instance, and only `parked` changed the run's state.
 * @throws If the workflow does not exist — an instance may still be tagged with its id, which is
 *   the reconciler's problem rather than this job's.
 */
export const pauseInstance = async (
  options: PauseInstanceOptions,
): Promise<PauseInstanceOutcome> => {
  const { compute, db, workflowId } = options
  const now = options.now ?? ((): Date => new Date())
  const pauseIdleCeilingMs = options.pauseIdleCeilingMs ?? PAUSE_IDLE_CEILING_MS

  const workflow = firstRow(
    await db
      .select({ state: workflows.state })
      .from(workflows)
      .where(eq(workflows.id, workflowId))
      .limit(1),
  )

  if (workflow === undefined) {
    throw new Error(
      `Workflow ${workflowId} does not exist, so there is no run to pause. An instance may still be tagged with this id, which is the reconciler's problem rather than this job's.`,
    )
  }

  if (workflow.state !== 'paused') {
    return {
      outcome: 'not_pausable',
      workflowId,
      state: workflow.state,
      reason:
        'FR-039 requires the agent to have reached a turn boundary and registered a durable snapshot before its instance is touched, and the acknowledged `paused` state is the platform’s record that both happened. A run in any other state has not made that statement.',
    }
  }

  // How long this pause has run, from the one row that records when it began. `undefined` is a
  // pause the timeline never recorded, and the answer to that is to leave the run alone rather
  // than to guess — a guess here parks somebody's thirty-second pause.
  const pauseBegan = await latestPausedEvent(db, workflowId)
  const pausedForMs =
    pauseBegan === undefined ? undefined : now().getTime() - pauseBegan.createdAt.getTime()
  /** How long the pause has run, but only once that is long enough to park it. */
  const pausedPastLimitForMs =
    pausedForMs !== undefined && pausedForMs > pauseIdleCeilingMs ? pausedForMs : undefined
  const parking = pausedPastLimitForMs !== undefined

  // Every path, one rule. See the module note: on spot the terminate is irreversible, on on-demand
  // the stop can fail to reverse (FR-043), and a park destroys the disk outright — so none of them
  // may proceed on a run that could not be rebuilt from its snapshot. Stated once, above the
  // branch, so no path can acquire an exception to it.
  const snapshot = await resumableSnapshotFor(db, workflowId)

  if (snapshot === undefined) {
    return {
      outcome: 'refused',
      workflowId,
      // Two readings of the same refusal, because they are two different pieces of news. FR-045
      // makes the park one a *condition to be raised*: the run is past its idle limit, the platform
      // would ordinarily stop paying for it, and it is going on paying instead because the only
      // alternative is to destroy the disk holding work nothing else has a copy of.
      reason: parking
        ? 'The run is past its pause idle limit but has no current snapshot carrying both conversation and worktree state, so parking it would release a disk that is the only copy of its work. Its instance and disk are left in place — and left billing — until the snapshot is resumable or somebody decides the work is expendable, because an unresumable park is indistinguishable from data loss (003/FR-045).'
        : 'The run has no current snapshot carrying both conversation and worktree state, so there is nothing to fall back to if its instance does not come back. Its instance is left running rather than stopped, because an unresumable pause is indistinguishable from lost work (003/FR-039, FR-043).',
    }
  }

  const lease = firstRow(
    await db
      .select({
        id: computeLeases.id,
        providerInstanceId: computeLeases.providerInstanceId,
        purchaseMode: computeLeases.purchaseMode,
      })
      .from(computeLeases)
      .where(and(eq(computeLeases.workflowId, workflowId), isNull(computeLeases.releasedAt)))
      .limit(1),
  )

  /**
   * Call the bet: release the environment, mark the run parked, keep the seat (FR-044, FR-073).
   *
   * Give up first, record second, which is the order every destructive path in this directory uses:
   * the run's state is the platform's claim about the world, and writing the claim before making it
   * true leaves a `parked_resumable` run whose instance is still running if the terminate throws.
   * The other way round, a crash between the two leaves a released environment and a `paused` run,
   * which the next invocation of this job — or `reconcile.ts` — finishes correctly.
   *
   * The state move is conditional on the run still being `paused`. It is not idempotence (a second
   * park is refused as `not_pausable` long before it reaches here) but a race: if an executor's
   * outcome landed while the environment was being released, FR-064 says its account wins, and this
   * must not overwrite it. The environment is released either way, which is the part that costs
   * money.
   *
   * @param pausedFor - How long the pause had run, recorded so the decision is auditable.
   */
  const parkRun = async (pausedFor: number): Promise<PauseInstanceOutcome> => {
    const given = await giveUpEnvironment({
      db,
      compute,
      workflowId,
      cause: 'parked_past_idle_limit',
      now,
    })

    if (given.outcome === 'refused') {
      // Unreachable while the precondition above holds, and kept anyway: it is the same refusal,
      // and a park that could route around it by taking a different way in would be FR-045 holding
      // by luck.
      return { outcome: 'refused', workflowId, reason: given.reason }
    }

    const environment: GivenUpEnvironment = given
    const reason =
      `The pause ran for ${String(Math.round(pausedFor / 1000))}s, beyond the ` +
      `${String(Math.round(pauseIdleCeilingMs / 1000))}s idle limit, so the run was parked: its ` +
      'instance and disk were released and it stands on its durable snapshot. It is parked rather ' +
      'than failed — nothing was lost, and resuming continues from the snapshot — and it keeps the ' +
      'agent credential it has held throughout (003/FR-044, FR-073).'

    await db.transaction(async (tx) => {
      const locked = firstRow(
        await tx
          .select({ state: workflows.state })
          .from(workflows)
          .where(eq(workflows.id, workflowId))
          .for('update'),
      )

      if (locked?.state !== 'paused') {
        return
      }

      await tx
        .update(workflows)
        .set({
          state: 'parked_resumable',
          terminalOutcome: 'parked_resumable',
          outcomeReason: reason,
        })
        .where(eq(workflows.id, workflowId))

      // A `parked` row of its own, unlike the pause path's merge: this is a second event in the
      // run's life rather than a fact learned about the first one, and the `paused` row it sits
      // after is what says when the pause that led here began.
      await tx.insert(workflowEvents).values({
        workflowId,
        event: 'parked',
        actorType: 'control_plane',
        detail: {
          cause: 'parked_past_idle_limit' satisfies SnapshotRecoveryCause,
          pausedForMs: pausedFor,
          idleCeilingMs: pauseIdleCeilingMs,
          releasedInstanceId: environment.terminatedInstanceId ?? null,
          snapshotId: environment.snapshot.id,
          // Named on the record because "which identity is this seat still being held for" is the
          // question the pool view answers about a parked holder (FR-073, FR-074).
          agentCredentialId: environment.agentCredentialId ?? null,
        },
      })
    })

    return {
      outcome: 'parked',
      workflowId,
      releasedInstanceId: environment.terminatedInstanceId,
      snapshotId: environment.snapshot.id,
      pausedForMs: pausedFor,
      agentCredentialId: environment.agentCredentialId,
      queueDrainError: await drainAfterRelease(options.queueDrain),
    }
  }

  // Before the `no_instance` answer below, because a park is not about the instance. A spot pause
  // has already given its instance up and is still a run holding a seat, a snapshot and a place in
  // somebody's afternoon; past the limit it must park like any other, or the one purchase mode that
  // is the platform default would be the one that never parks.
  if (pausedPastLimitForMs !== undefined) {
    return parkRun(pausedPastLimitForMs)
  }

  if (lease?.providerInstanceId == null) {
    // Already given up — by an earlier pause, by the reconciler, or by a spot reclamation. Not an
    // error: this job is retried, and a run with no instance is exactly where a pause wanted it.
    return {
      outcome: 'no_instance',
      workflowId,
      agentCredentialId: await seatHeldBy(db, workflowId),
    }
  }

  const instanceId = lease.providerInstanceId
  // The **lease's** purchase mode, not the workflow's. They agree today because provisioning copies
  // one to the other, but the lease is the record of what was actually bought, and it is the thing
  // EC2 will or will not let the platform stop.
  const purchaseMode = lease.purchaseMode

  /** Give the environment up through the FR-043 path, and record the pause as having taken it. */
  const recoverThrough = async (cause: SnapshotRecoveryCause): Promise<PauseInstanceOutcome> => {
    const given = await giveUpEnvironment({ db, compute, workflowId, cause, now })

    if (given.outcome === 'refused') {
      return { outcome: 'refused', workflowId, reason: given.reason }
    }

    const environment: GivenUpEnvironment = given

    await recordPausePath({
      db,
      workflowId,
      detail: {
        pausePath: 'snapshot_recovery' satisfies PausePath,
        purchaseMode,
        cause,
        terminatedInstanceId: environment.terminatedInstanceId ?? null,
        snapshotId: environment.snapshot.id,
        agentCredentialId: environment.agentCredentialId ?? null,
      },
    })

    return {
      outcome: 'paused',
      path: 'snapshot_recovery',
      workflowId,
      purchaseMode,
      cause,
      terminatedInstanceId: environment.terminatedInstanceId,
      snapshotId: environment.snapshot.id,
      agentCredentialId: environment.agentCredentialId,
      // Only this path frees a slot under the FR-040 ceiling, and nothing else re-examines the
      // queue. See `teardown-workflow.ts`: without a drain, a released lease builds a queue
      // nothing empties.
      queueDrainError: await drainAfterRelease(options.queueDrain),
    }
  }

  if (purchaseMode === 'spot') {
    // The degraded path, and the one that keeps the FR-043 recovery exercised (research R6).
    return recoverThrough('spot_cannot_stop')
  }

  try {
    await compute.stop({ instanceId })
  } catch {
    // The instance is still running and still billing, and the pause cannot be taken the cheap
    // way. Giving it up is worse for the resume and better for the bill, and it is the same
    // fallback the other two causes take rather than a third behaviour invented here.
    return recoverThrough('instance_would_not_stop')
  }

  // After the stop, never before: what makes this a fact rather than an intention is that it is
  // read back from the provider once the instance is off (FR-039).
  const retainedVolumes = await compute.describeVolumes({ instanceId })
  const agentCredentialId = await seatHeldBy(db, workflowId)

  // The lease is deliberately **not** released. The instance still exists, it still belongs to this
  // run, and its id on the lease is how the resume finds it again (FR-041). Releasing it here would
  // free a concurrency slot the run has not given up and would strand the instance, stopped, with
  // nothing recording that it is anybody's.
  await recordPausePath({
    db,
    workflowId,
    detail: {
      pausePath: 'stopped' satisfies PausePath,
      purchaseMode,
      instanceId,
      retainedVolumeIds: retainedVolumes.map((volume) => volume.volumeId),
      agentCredentialId: agentCredentialId ?? null,
    },
  })

  return {
    outcome: 'paused',
    path: 'stopped',
    workflowId,
    purchaseMode,
    instanceId,
    retainedVolumes,
    agentCredentialId,
  }
}

/** Pause wrapped in the uniform job envelope. */
export const runPauseInstance = (
  options: PauseInstanceOptions,
): Promise<JobOutcome<PauseInstanceOutcome>> =>
  runJob(PAUSE_INSTANCE_JOB_NAME, () => pauseInstance(options))
