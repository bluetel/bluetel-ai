/**
 * **The spot-interruption watch (T100, FR-054, R3).**
 *
 * A capacity interruption is a pause that nobody asked for. FR-054 says so and R3 explains why it
 * has to be implemented that way: interruption handling that is only exercised when a reclamation
 * actually happens is handling that is never tested, and it rots silently until the first
 * reclamation of a long run. So this module contains **no** suspension logic. It watches, and when
 * it sees a notice it calls the same {@link suspend} every manual pause goes through — which means
 * the interruption path is exercised every time anybody presses Pause.
 *
 * That reuse is enforced by the type rather than by this comment. {@link InterruptionWatchOptions}
 * carries `suspension: Omit<SuspendOptions, 'reason'>`: there is no field in which a caller could
 * put a different reason, and no second entry point to call. Adding a parallel interruption
 * handler would mean adding a parameter that does not exist.
 *
 * ## Why the watch lives here rather than in the control plane
 *
 * Detection has to happen in the process that owns the snapshot. A reclamation notice gives a
 * couple of minutes; a control plane that noticed and then had to reach *in* to tell the instance
 * would need an inbound path onto the instance, which FR-035 rules out, and would spend some of
 * that budget on a round trip it does not have to spend. The executor already holds the agent
 * handle, the workspace and the snapshot writer, so it can go from notice to registered snapshot
 * without asking anybody.
 *
 * ## The metadata reader is injected, and that is not a testing convenience
 *
 * Spike S2 observed **nothing** about instance metadata: no IMDS, no reclamation notice, no
 * user-data hand-off, no instance-profile differences between two machines. Its instance identity
 * was a directory. So the thing that decides "a notice has arrived" is
 * {@link InstanceMetadataReader}, an interface with an unproven implementation behind it, and
 * everything above it — the polling, the deduplication, the routing into `suspend()` — is decided
 * against that interface and proved against a fake. The first genuine confirmation lands with the
 * provisioning work; until then, treat the *watch* as tested and the *notice* as assumed.
 */

import type { SuspendOptions, SuspendResult } from './suspend'
import { suspend } from './suspend'

/** A capacity-interruption warning, as an instance metadata service would report one. */
export interface InterruptionNotice {
  /** When the instance is expected to be taken away. */
  readonly reclaimAt: Date
  /**
   * Verbatim from the metadata service, for the record. Never parsed into behaviour: an action
   * string this executor has not seen before is still a notice, and treating it as absent because
   * it did not match a known value is how a run gets reclaimed unsnapshotted.
   */
  readonly action: string
}

/**
 * The one thing this module cannot prove.
 *
 * One method, deliberately. A reader that also exposed the instance id or the region would invite
 * the rest of the executor to reach through it, and this seam exists to be replaceable.
 *
 * @returns The notice, or `null` while none has been issued. **Rejecting is not the same as
 *   `null`**: a metadata endpoint that is briefly unreachable must not be read as "no notice", so
 *   implementations reject and {@link watchForInterruption} counts the failure rather than
 *   concluding anything from it.
 */
export interface InstanceMetadataReader {
  readonly readInterruptionNotice: () => Promise<InterruptionNotice | null>
}

/**
 * How often the metadata service is asked.
 *
 * Five seconds against a notice period measured in minutes. Cheap enough to be unnoticeable and
 * frequent enough that the polling interval is a rounding error against the time the snapshot
 * itself takes.
 */
export const DEFAULT_INTERRUPTION_POLL_MS = 5_000

/** A reader that never reports a notice. The default, so a run without one is not a special case. */
export const createQuietMetadataReader = (): InstanceMetadataReader => ({
  readInterruptionNotice: () => Promise.resolve(null),
})

export interface InterruptionWatchOptions {
  readonly metadata: InstanceMetadataReader
  /**
   * Everything `suspend()` needs **except the reason**, which this module supplies and no caller
   * can override. See the module comment: this is the mechanism, not a convention.
   */
  readonly suspension: Omit<SuspendOptions, 'reason'>
  readonly pollIntervalMs?: number
  /** Ends the watch — the run finished on its own, which is the ordinary outcome. */
  readonly signal?: AbortSignal
  /** Called the moment a notice is seen, before the suspension starts. */
  readonly onNotice?: (notice: InterruptionNotice) => void
  /** Called when the metadata service could not be read. Reported, never treated as "no notice". */
  readonly onReadFailure?: (error: unknown, consecutiveFailures: number) => void
  /** Injected so a test steps the clock rather than waiting. */
  readonly sleep?: (milliseconds: number) => Promise<void>
}

/** Why the watch stopped. */
export type InterruptionWatchStop = 'interrupted' | 'aborted'

export interface InterruptionWatchResult {
  readonly stoppedBecause: InterruptionWatchStop
  /** The notice that ended the watch, or `null` when the run finished first. */
  readonly notice: InterruptionNotice | null
  /** What `suspend()` did, or `null` when there was nothing to suspend for. */
  readonly suspension: SuspendResult | null
  readonly polls: number
  readonly readFailures: number
}

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref()
  })

/**
 * Poll instance metadata until a notice arrives or the run ends.
 *
 * On a notice this calls `suspend({ reason: 'interruption', ... })` and returns what it did. It
 * does not release compute, stop the agent or acknowledge anything itself — all three are
 * `suspend()`'s, and doing any of them here would be the start of the second code path FR-054
 * exists to prevent.
 *
 * @param options - See {@link InterruptionWatchOptions}.
 * @returns What the watch saw and what the suspension did.
 */
export const watchForInterruption = async (
  options: InterruptionWatchOptions,
): Promise<InterruptionWatchResult> => {
  const sleep = options.sleep ?? defaultSleep
  const interval = options.pollIntervalMs ?? DEFAULT_INTERRUPTION_POLL_MS
  let polls = 0
  let readFailures = 0

  while (options.signal?.aborted !== true) {
    polls += 1

    let notice: InterruptionNotice | null = null

    try {
      notice = await options.metadata.readInterruptionNotice()
    } catch (error) {
      // An unreachable metadata service is not evidence of anything. Counted and reported, so a
      // watch that has learned nothing for ten minutes is visible rather than reassuring.
      readFailures += 1
      options.onReadFailure?.(error, readFailures)
    }

    if (notice !== null) {
      options.onNotice?.(notice)

      return {
        stoppedBecause: 'interrupted',
        notice,
        suspension: await suspend({ ...options.suspension, reason: 'interruption' }),
        polls,
        readFailures,
      }
    }

    await sleep(interval)
  }

  return { stoppedBecause: 'aborted', notice: null, suspension: null, polls, readFailures }
}
