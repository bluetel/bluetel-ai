/**
 * **`suspend()` — one routine for pause, interruption and stop (T091, FR-049, FR-050, FR-054, R3).**
 *
 * FR-054 requires it and R3 explains why: interruption handling that is only exercised when a spot
 * reclamation actually happens is handling that is never tested, and it rots silently until the
 * first reclamation of a long run. Routing the user-facing pause button through the same code makes
 * the interruption path exercised on every single manual pause.
 *
 * So there is one function, and the three causes differ in exactly two things — the `reason`
 * recorded and whether compute is released immediately. Both differences are data
 * ({@link suspensionPlanFor}), not branches: a pure lookup that a test can enumerate, rather than
 * three code paths that drift.
 *
 * ## The order, and the one ordering rule that is a requirement
 *
 * ```
 * 1. quiesce()                            turn boundary, process alive
 * 1a. flushCredentialRotation()           write through anything the agent rotated (003/FR-030)
 * 2. snapshot()                           capture the workspace, park and retry on failure
 * 3. registerSnapshot(boundary)           machine surface
 * 4. acknowledge()                        <- the user is told only here
 * 5. mark suspended
 * 6. end the agent                        all three causes, since 003/FR-039
 * 7. release compute                      immediate for interruption and stop; for a pause the
 *                                         control plane stops the instance from outside
 * ```
 *
 * ## Step 6, and what changed about pause (003/T098, FR-039)
 *
 * 002 paused by holding the agent process alive on a running instance (`002/FR-049`), so the
 * conversation stayed in memory and a resume was instant — and the instance billed the whole time,
 * which is why pauses were something to avoid. 003/FR-039 replaces that: the instance is **stopped**
 * with its disk retained, and a resume is `StartInstances` against the same box. The stop is issued
 * by the control plane, because an instance may never stop itself — see
 * {@link suspensionPlanFor}'s pause plan for both halves of why, and for why the agent is now ended
 * on a pause as it always was on the other two.
 *
 * The rotation flush at step 1a stays exactly where it is, and moves up in importance rather than
 * down: an instance that is about to be frozen for an hour is an instance whose credential file is
 * about to stop being written to, and a rotation still inside its debounce window when that happens
 * is a seat that comes back needing an administrator to log in again.
 *
 * ## Step 1a, and why it is here rather than at three call sites (003/T060, FR-030, R3)
 *
 * The agent refreshes its own login as it works, and `credential/rotation-watch.ts` debounces those
 * changes before writing them through. A rotation observed moments before a suspension is therefore
 * still inside its debounce window when the instance stops — and losing it is not a lost log line,
 * it is the difference between a seat that resumes and a seat that needs an administrator to log in
 * again, because the material the platform holds no longer works.
 *
 * One flush here covers all three causes precisely because this routine is the only way any of them
 * is reached: `run/execute.ts` calls it for a pause and a stop, and `session/interruption.ts` calls
 * it for a reclamation notice, all three through the same options object. A flush written at those
 * call sites would be three flushes, and the spot-interruption one would be the one nobody
 * exercised — which is the failure FR-054 made this a single routine to prevent in the first place.
 *
 * **After the quiesce, before the snapshot.** After, because a turn boundary is the point at which
 * the agent is no longer writing, so the file being read is a whole file rather than a half-written
 * one. Before, because everything below step 2 can park for minutes against unreachable storage,
 * and a rotation is small, fast and completely independent of the object store — putting it after
 * would mean an instance reclaimed during a park lost a credential it had already observed, for the
 * sake of an ordering that buys nothing.
 *
 * A quiesce that times out rejects before this runs, and that loses nothing: the run carries on, the
 * watcher is still armed, and the next suspension flushes what this one did not. The flush itself
 * never rejects — see {@link SuspendOptions.flushCredentialRotation}.
 *
 * **Acknowledgement comes after step 3.** That is FR-049 and it is the reason this routine exists as
 * a routine rather than as five calls at a call site: the working tree must be captured *and
 * registered* before the user is told the run is paused. Acknowledging earlier would make "paused"
 * mean "we have asked the agent to stop and we hope the snapshot works out", and the person reading
 * it has no way to tell the difference. `suspend.test.ts` asserts the call order directly, because
 * this is the rule most easily lost to a well-meaning "acknowledge as early as possible" edit.
 *
 * **Quiesce is not a kill.** It waits for the current turn to finish and leaves the process alive
 * (`agent/cli-stream.ts` explains why the `control_request`/`interrupt` channel was evaluated and
 * rejected for this). A snapshot taken mid-turn contains a working tree the agent was halfway
 * through editing, which is not a resumable state.
 *
 * ## Every step is bounded, and each bound is the term `supervision/budget.ts` gave it (T185)
 *
 * SC-003 gives the whole pause path ten seconds and `supervision/budget.ts` divides them up. Three
 * of its terms are spent inside this routine — the quiesce, the capture and the registration — and
 * each is now passed to the operation it names rather than merely declared beside it (FR-205).
 * What happens on an overrun differs by step, and the differences are the design:
 *
 * - **quiesce** rejects. Nothing below step 1 runs, the pause is acknowledged `rejected` naming
 *   the term, and the run carries on running. That is the only safe answer: the alternative is
 *   snapshotting a working tree the agent is halfway through editing, and SC-003's other half
 *   forbids losing work.
 * - **capture** fails that attempt, which is a park (`park.ts`, FR-082) — the run holds at the
 *   boundary and retries, and the retries are given {@link SNAPSHOT_RETRY_BUDGET_MS} rather than
 *   the first attempt's share, because by then the deadline is missed and the requirement still in
 *   force is that no work is lost.
 * - **registerSnapshot** rejects, and nothing is acknowledged. FR-049's ordering means an
 *   unregistered snapshot must never be reported as a pause, so a slow registration fails the
 *   pause rather than quietly acknowledging one that cannot be resumed.
 *
 * ## The injected port
 *
 * The snapshot writer arrives as {@link SnapshotPort} — an injected dependency, named `snapshot`.
 * `session/snapshot.ts` is Phase 8 and belongs to another agent; this file must not reach into it,
 * and does not import it. What `suspend()` needs from a snapshot writer is one method,
 * {@link SnapshotPort.capture}, taking the boundary and the pinned root and answering with the
 * object key and the two state flags FR-050 requires. Phase 8 supplies an implementation; the tests
 * here supply a fake, including one that fails so the park-and-retry path is exercised.
 */

import type { AgentQuiescedState, AgentUsage } from '../agent'
import {
  ACKNOWLEDGE_BUDGET_MS,
  QUIESCE_BUDGET_MS,
  SNAPSHOT_CAPTURE_BUDGET_MS,
  SNAPSHOT_REGISTER_BUDGET_MS,
  SNAPSHOT_RETRY_BUDGET_MS,
  withDeadline,
} from '../supervision'

import type { ParkBudget, ParkReport, SnapshotBoundary } from './park'
import { parkAndRetry } from './park'

/** Why the run is being suspended. All three go through this one routine (FR-054, R3). */
export type SuspendReason = 'pause' | 'interruption' | 'stop'

/**
 * What happens to the compute this run is holding.
 *
 * `immediate` is the executor handing the instance back itself. `on-instance-stop` is 003/FR-039:
 * the executor hands nothing back, and the **control plane** stops the instance from outside with
 * its disk retained. The two are different actors, which is why they are different values rather
 * than a boolean — see {@link SuspensionPlan.computeRelease}.
 */
export type ComputeRelease = 'immediate' | 'on-instance-stop'

/** How one cause differs from the other two. Data, not branches. */
export interface SuspensionPlan {
  readonly reason: SuspendReason
  /** Recorded on the snapshot, so a resume knows what it is resuming from. */
  readonly boundary: SnapshotBoundary
  readonly computeRelease: ComputeRelease
  /**
   * True when the agent process is ended as part of the suspension.
   *
   * True for all three causes since 003/FR-039. It was false for a pause under `002/FR-049`, when a
   * pause kept the process alive on a running instance; see the pause plan for why that is now the
   * opposite of what a pause wants.
   */
  readonly stopsAgent: boolean
}

const PLANS: Readonly<Record<SuspendReason, SuspensionPlan>> = {
  /**
   * **Pause stops the agent and waits to be stopped (003/T098, 003/FR-039).**
   *
   * Until 003 this plan said `stopsAgent: false` and held the process alive on a running instance,
   * which is `002/FR-049` and which 003/FR-039 supersedes: a pause now brings the agent to a turn
   * boundary, captures a durable snapshot, and then the **control plane** stops the instance with
   * its disk retained. Two things about this plan follow from that, and both are the change.
   *
   * **The agent is ended.** Not to save anything — the process dies the moment the instance stops
   * either way — but because of what it could do in the seconds before that. The snapshot has just
   * been captured; an agent still running could write to the working tree afterwards, and the disk
   * and the snapshot would then disagree. On an on-demand pause that divergence is confusing. On
   * the FR-043 fallback — where the instance is given up and the snapshot is the only thing that
   * survives — it is silent data loss, because the writes that were lost are exactly the ones
   * nobody recorded. Quiescing and then leaving the agent running would be keeping a writer alive
   * over a frozen copy of what it was writing to.
   *
   * **Compute is not released here, and is not held for ever either.** The executor cannot stop its
   * own instance: every instance the platform launches carries
   * `InstanceInitiatedShutdownBehavior: 'terminate'`, so an executor that shut itself down would
   * destroy the disk this pause exists to keep. So `on-instance-stop` means "somebody else, from
   * outside, and soon" — `apps/sisyphus-control-plane/src/jobs/pause-instance.ts`, off the
   * acknowledged pause.
   *
   * `./idle-ceiling.ts` still runs and is still worth having. It is no longer the mechanism that
   * ends a pause — the control plane's stop lands first, and a stopped instance's in-process timer
   * can never fire — it is the backstop for the case where that stop never comes at all, which is
   * the same reason `jobs/reconcile.ts` enforces the ceiling a second time from the other side.
   */
  pause: {
    reason: 'pause',
    boundary: 'pause',
    computeRelease: 'on-instance-stop',
    stopsAgent: true,
  },
  /**
   * An interruption has a deadline set by somebody else. Nothing is held: the snapshot is the only
   * thing that survives, so the process ends and the compute goes back as soon as it is written.
   */
  interruption: {
    reason: 'interruption',
    boundary: 'interruption',
    computeRelease: 'immediate',
    stopsAgent: true,
  },
  /** Stop ends the run cleanly after capturing everything (FR-049). */
  stop: {
    reason: 'stop',
    boundary: 'stop',
    computeRelease: 'immediate',
    stopsAgent: true,
  },
}

/**
 * The plan for one cause.
 *
 * Total over the three reasons, so there is no fallback to get wrong, and pure, so
 * "an interruption releases compute immediately and a pause does not" is a rule under test rather
 * than a comment.
 */
export const suspensionPlanFor = (reason: SuspendReason): SuspensionPlan => PLANS[reason]

/** What a snapshot writer answers with. */
export interface CapturedSnapshot {
  /** Where the archive was written. */
  readonly s3Key: string
  readonly sizeBytes: number
  /**
   * FR-050 requires both. A snapshot missing either is not resumable, which is why they are
   * reported by the writer rather than assumed by the caller.
   */
  readonly hasConversationState: boolean
  readonly hasWorktreeState: boolean
}

/** What a snapshot writer is asked for. */
export interface SnapshotRequest {
  readonly boundary: SnapshotBoundary
  /** The platform-assigned session id (FR-052). */
  readonly sessionId: string
  /** The pinned workspace root — the same absolute path on every instance (FR-051, R2). */
  readonly workspaceRoot: string
}

/**
 * **The injected port. `session/snapshot.ts` (Phase 8, T097) supplies the implementation.**
 *
 * One method, so the seam is as small as it can be. `suspend()` does not know whether the archive is
 * a `tar.zst`, where it goes, or what is excluded from it — including the credential subtree FR-072
 * keeps out of every snapshot. Those are the snapshot writer's decisions and belong on its side of
 * this interface.
 */
export interface SnapshotPort {
  readonly capture: (request: SnapshotRequest) => Promise<CapturedSnapshot>
}

/** Registering the snapshot against the workflow, so it can be resumed (FR-050). */
export interface SnapshotRegistration extends CapturedSnapshot {
  readonly boundary: SnapshotBoundary
  readonly sessionId: string
}

/** Only what `suspend()` needs from the agent: a boundary, and optionally an end. */
export interface SuspendAgentPort {
  readonly quiesce: (options?: { timeoutMs?: number }) => Promise<AgentQuiescedState>
  readonly stop: (options: { force: boolean; timeoutMs?: number }) => Promise<unknown>
}

export interface SuspendOptions {
  readonly reason: SuspendReason
  readonly agent: SuspendAgentPort
  /** The injected snapshot writer. See {@link SnapshotPort}. */
  readonly snapshot: SnapshotPort
  readonly sessionId: string
  readonly workspaceRoot: string
  /** `registerSnapshot` on the machine surface. */
  readonly registerSnapshot: (registration: SnapshotRegistration) => Promise<void>
  /**
   * Told the user. Called **after** registration and never before (FR-049). Absent for an
   * interruption, which nobody asked for and so has no command to acknowledge.
   */
  readonly acknowledge?: () => Promise<void>
  /**
   * Write through any rotation the agent has made but the watcher has not yet reported
   * (003/FR-030, 003/T060, research R3).
   *
   * Supplied by `run/execute.ts` from `credential/rotation-watch.ts`, once, for all three causes —
   * see the module note for why this is the right place for it and why it sits where it does in the
   * order.
   *
   * **It must not reject, and the contract is the watch's rather than this routine's**: a suspension
   * that failed because a credential write failed would take the snapshot down with it, and the
   * snapshot is the work. `RotationWatch.flush` is written to that rule and reports its failures
   * through its own `onFailure`. A rejection here is nevertheless caught rather than trusted not to
   * happen, because "an optional callback somebody else supplies" is not a place to rely on a
   * convention.
   */
  readonly flushCredentialRotation?: () => Promise<unknown>
  /** Record the suspension against the workflow. */
  readonly markSuspended?: (plan: SuspensionPlan) => Promise<void>
  /** Hand the instance back. Called only when the plan says `immediate`. */
  readonly releaseCompute?: () => Promise<void>
  /** Bounded, because SC-003 gives the whole pause path ten seconds. See `supervision/budget.ts`. */
  readonly quiesceTimeoutMs?: number
  /** The first capture attempt's share. Defaults to {@link SNAPSHOT_CAPTURE_BUDGET_MS}. */
  readonly snapshotCaptureBudgetMs?: number
  /** What every attempt after the first gets. Defaults to {@link SNAPSHOT_RETRY_BUDGET_MS}. */
  readonly snapshotRetryBudgetMs?: number
  /** `registerSnapshot`'s share. Defaults to {@link SNAPSHOT_REGISTER_BUDGET_MS}. */
  readonly snapshotRegisterBudgetMs?: number
  /**
   * {@link SuspendOptions.acknowledge}'s share. Defaults to {@link ACKNOWLEDGE_BUDGET_MS}.
   *
   * The assembled run acknowledges through the supervision queue rather than through this option
   * (see `run/execute.ts`), so in practice this bounds only a caller that supplies its own
   * acknowledgement — never both, and so never double-counted against the one term.
   */
  readonly acknowledgeBudgetMs?: number
  readonly parkBudget?: ParkBudget
  /** Injectable clock, so {@link SuspendResult.suspendedAt} is testable without waiting. */
  readonly now?: () => Date
  /** Reported while storage is unreachable, so the panel says "waiting on storage" (FR-082). */
  readonly onParked?: (report: ParkReport) => void
  readonly sleep?: (milliseconds: number) => Promise<void>
}

/** What the suspension did. */
export interface SuspendResult {
  readonly plan: SuspensionPlan
  /**
   * **When the suspension began — the `paused_at` FR-049's idle ceiling counts from (T181).**
   *
   * Taken before `quiesce`, not after the acknowledgement, and that is deliberate: the ceiling
   * measures how long a person has left a run untouched, and the seconds the platform spent
   * reaching a turn boundary and writing a snapshot are not theirs. Recording it at the end would
   * also make a pause that parked on unreachable storage for two minutes look two minutes fresher
   * than it is.
   *
   * The control plane holds the durable copy of this — the `paused` row on `workflow_events`,
   * written by `acknowledgeSupervisionCommand` — because a value that only exists in this
   * process's memory is gone the moment the ceiling matters most. See
   * `apps/sisyphus-control-plane/src/jobs/reconcile.ts`.
   */
  readonly suspendedAt: Date
  readonly snapshot: CapturedSnapshot
  /** Consumption as at the boundary — what the snapshot was registered against. */
  readonly usage: AgentUsage
  /** True when a turn was in flight and had to be waited out. */
  readonly waitedForTurn: boolean
  /** True when the user was told. False for an interruption, which had nobody to tell. */
  readonly acknowledged: boolean
  readonly computeReleased: boolean
  /** Number of storage attempts that failed before the snapshot was written (FR-082). */
  readonly parkedAttempts: number
}

/**
 * Suspend the run: quiesce, snapshot, register, acknowledge, mark, release.
 *
 * @param options - See {@link SuspendOptions}.
 * @throws SnapshotBoundaryUnpersistedError when storage stays unreachable for the whole park budget.
 *   The error names the boundary it could not persist (FR-082); nothing below step 3 has run, so
 *   nothing has been acknowledged and no compute has been released.
 */
export const suspend = async (options: SuspendOptions): Promise<SuspendResult> => {
  const plan = suspensionPlanFor(options.reason)
  // Before anything else runs: the idle ceiling counts from the request, not from the outcome.
  const suspendedAt = (options.now ?? ((): Date => new Date()))()

  // 1. A turn boundary, with the process alive. Rejects rather than returning if no boundary is
  //    reached in time, so nothing below runs on the assumption that one was.
  //
  //    Bounded twice, and deliberately. The timeout is *passed* to the adapter, which rejects with
  //    `quiesce-timeout` and is the better error because it knows what it was waiting for; and the
  //    call is *also* wrapped, because passing a number to a port is a request rather than a
  //    bound. An adapter that ignores `timeoutMs` — a fake, a future adapter, a bug — would
  //    otherwise leave the largest term of the SC-003 budget silently unenforced, which is
  //    precisely the shape FR-205 exists to forbid.
  const quiesceBudgetMs = options.quiesceTimeoutMs ?? QUIESCE_BUDGET_MS
  const quiesced = await withDeadline(() => options.agent.quiesce({ timeoutMs: quiesceBudgetMs }), {
    operation: 'waiting for the agent to reach a turn boundary',
    budgetMs: quiesceBudgetMs,
  })

  // 1a. The agent has stopped writing, so whatever is in its credential file is a whole file.
  //     Write it through before anything that can park (003/FR-030). Never fatal: losing a
  //     rotation is bad, and losing the snapshot to it would be worse.
  await options.flushCredentialRotation?.().catch(() => undefined)

  // 2. Capture. Parking holds *here* — at the boundary step 1 reached — so the cost of an
  //    unreachable store is storage retries rather than re-run inference. No turn is sent between
  //    attempts because there is no code between them that could send one.
  let parkedAttempts = 0
  let captureAttempt = 0
  const captured = await parkAndRetry({
    boundary: plan.boundary,
    budget: options.parkBudget,
    sleep: options.sleep,
    onParked: (report) => {
      parkedAttempts = report.attempt
      options.onParked?.(report)
    },
    operation: () => {
      captureAttempt += 1

      // The first attempt is inside SC-003 and gets its share of the ten seconds. Every attempt
      // after it is already outside, so it gets room to finish instead — see `budget.ts`.
      return withDeadline(
        () =>
          options.snapshot.capture({
            boundary: plan.boundary,
            sessionId: options.sessionId,
            workspaceRoot: options.workspaceRoot,
          }),
        {
          operation: `capturing the ${plan.boundary} snapshot`,
          budgetMs:
            captureAttempt === 1
              ? (options.snapshotCaptureBudgetMs ?? SNAPSHOT_CAPTURE_BUDGET_MS)
              : (options.snapshotRetryBudgetMs ?? SNAPSHOT_RETRY_BUDGET_MS),
        },
      )
    },
  })

  // 3. Register it against the workflow, with both state flags (FR-050).
  await withDeadline(
    () =>
      options.registerSnapshot({
        ...captured,
        boundary: plan.boundary,
        sessionId: options.sessionId,
      }),
    {
      operation: `registering the ${plan.boundary} snapshot`,
      budgetMs: options.snapshotRegisterBudgetMs ?? SNAPSHOT_REGISTER_BUDGET_MS,
    },
  )

  // 4. **Only now** is the user told. See the module comment: this line's position is FR-049.
  const acknowledged = options.acknowledge !== undefined
  const acknowledge = options.acknowledge

  if (acknowledge !== undefined) {
    await withDeadline(async () => acknowledge(), {
      operation: `acknowledging the ${plan.reason}`,
      budgetMs: options.acknowledgeBudgetMs ?? ACKNOWLEDGE_BUDGET_MS,
    })
  }

  // 5. Record the suspension.
  await options.markSuspended?.(plan)

  // 6. End the agent. On all three causes since 003/FR-039: whatever happens to the instance next,
  //    nothing may write to the working tree after the snapshot of it has been taken.
  if (plan.stopsAgent) {
    await options.agent.stop({ force: false })
  }

  // 7. Release compute — immediately for an interruption or a stop. A pause releases nothing here
  //    and cannot: the control plane stops the instance from outside, because an executor that
  //    shut itself down would terminate the disk the pause exists to keep.

  const computeReleased = plan.computeRelease === 'immediate'

  if (computeReleased) {
    await options.releaseCompute?.()
  }

  return {
    plan,
    suspendedAt,
    snapshot: captured,
    usage: quiesced.usage,
    waitedForTurn: quiesced.waitedForTurn,
    acknowledged,
    computeReleased,
    parkedAttempts,
  }
}
