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
  readonly parkBudget?: ParkBudget
  /** Reported while storage is unreachable, so the panel says "waiting on storage" (FR-082). */
  readonly onParked?: (report: ParkReport) => void
  readonly sleep?: (milliseconds: number) => Promise<void>
}

/** What the suspension did. */
export interface SuspendResult {
  readonly plan: SuspensionPlan
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

  // 1. A turn boundary, with the process alive. Rejects rather than returning if no boundary is
  //    reached in time, so nothing below runs on the assumption that one was.
  const quiesced = await options.agent.quiesce({ timeoutMs: options.quiesceTimeoutMs })

  // 2. Capture. Parking holds *here* — at the boundary step 1 reached — so the cost of an
  //    unreachable store is storage retries rather than re-run inference. No turn is sent between
  //    attempts because there is no code between them that could send one.
  let parkedAttempts = 0
  const captured = await parkAndRetry({
    boundary: plan.boundary,
    budget: options.parkBudget,
    sleep: options.sleep,
    onParked: (report) => {
      parkedAttempts = report.attempt
      options.onParked?.(report)
    },
    operation: () =>
      options.snapshot.capture({
        boundary: plan.boundary,
        sessionId: options.sessionId,
        workspaceRoot: options.workspaceRoot,
      }),
  })

  // 3. Register it against the workflow, with both state flags (FR-050).
  await options.registerSnapshot({
    ...captured,
    boundary: plan.boundary,
    sessionId: options.sessionId,
  })

  // 4. **Only now** is the user told. See the module comment: this line's position is FR-049.
  const acknowledged = options.acknowledge !== undefined
  await options.acknowledge?.()

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
    snapshot: captured,
    usage: quiesced.usage,
    waitedForTurn: quiesced.waitedForTurn,
    acknowledged,
    computeReleased,
    parkedAttempts,
  }
}
