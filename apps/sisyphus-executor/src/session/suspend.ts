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
 * 2. snapshot()                           capture the workspace, park and retry on failure
 * 3. registerSnapshot(boundary)           machine surface
 * 4. acknowledge()                        <- the user is told only here
 * 5. mark suspended
 * 6. release compute                      immediate for interruption and stop; on the idle
 *                                         ceiling for pause
 * ```
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

/** When the instance gives its compute back. */
export type ComputeRelease = 'immediate' | 'on-idle-ceiling'

/** How one cause differs from the other two. Data, not branches. */
export interface SuspensionPlan {
  readonly reason: SuspendReason
  /** Recorded on the snapshot, so a resume knows what it is resuming from. */
  readonly boundary: SnapshotBoundary
  readonly computeRelease: ComputeRelease
  /** True when the agent process is ended as part of the suspension. */
  readonly stopsAgent: boolean
}

const PLANS: Readonly<Record<SuspendReason, SuspensionPlan>> = {
  /**
   * Pause holds the process. Compute is released only when the pause idle limit is reached, which
   * moves the workflow to `parked_resumable` — **not** to failed (FR-050, US2 §4). Releasing
   * immediately would make every pause a restore cycle and would defeat the point of keeping the
   * conversation in memory.
   *
   * The limit itself is `./idle-ceiling.ts`, and {@link SuspendResult.suspendedAt} is when it
   * starts counting. Until T181 this plan value meant "do not release" and nothing else: there was
   * no threshold, no clock and nothing that ever acted on it, so `on-idle-ceiling` was in practice
   * "hold this instance for ever".
   */
  pause: {
    reason: 'pause',
    boundary: 'pause',
    computeRelease: 'on-idle-ceiling',
    stopsAgent: false,
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

  // 6. Release compute — immediately for an interruption or a stop, on the idle ceiling for a
  //    pause, which is a decision the platform makes later and not here.
  if (plan.stopsAgent) {
    await options.agent.stop({ force: false })
  }

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
