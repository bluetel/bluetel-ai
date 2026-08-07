/**
 * Named, individually timed bootstrap phases (T055, FR-145, FR-146).
 *
 * Bootstrap is the part of a run where a user is waiting and nothing visible is
 * happening. FR-145 exists because "provisioning" of unknown duration is the
 * state people cancel out of, and FR-146 exists because a phase with no timeout
 * of its own holds a paid instance until someone notices.
 *
 * So every phase runs through {@link runPhase}, which does four things and only
 * these four: it announces the start, it times the work, it enforces **that
 * phase's** timeout, and it reports the outcome with a reason. The consequence
 * is the property both requirements actually want — **there is no code path
 * that produces a bootstrap failure without a phase name attached to it.** A
 * generic "bootstrap failed" would have to be constructed deliberately, because
 * {@link BootstrapPhaseError} cannot be built without naming a phase.
 *
 * The phase vocabulary is imported from the API package rather than restated,
 * so the executor and the machine surface cannot drift on the spelling of a
 * name that ends up in a database enum.
 */

import { BOOTSTRAP_PHASES } from '@bluetel-ai/sisyphus-api/client'

export type BootstrapPhaseName = (typeof BOOTSTRAP_PHASES)[number]

export { BOOTSTRAP_PHASES }

export type BootstrapPhaseOutcome = 'succeeded' | 'failed' | 'timed_out'

/**
 * Per-phase timeouts, in the order the protocol runs them.
 *
 * They differ by an order of magnitude on purpose. A digest comparison that
 * takes thirty seconds is broken; a `setup.sh` that installs a toolchain and
 * takes ten minutes is ordinary. One shared bootstrap timeout would have to be
 * the largest of these, which would mean a hung download costs fifteen minutes
 * of instance time before anyone hears about it.
 *
 * `provisioning` is recorded by the control plane before hand-off, so the value
 * here is for completeness rather than for the executor to enforce.
 */
export const DEFAULT_PHASE_TIMEOUTS: Readonly<Record<BootstrapPhaseName, number>> = {
  provisioning: 600_000,
  bundle_download: 180_000,
  bundle_verify: 60_000,
  bundle_unpack: 180_000,
  setup_script: 900_000,
  entry_checkout: 600_000,
  agent_start: 120_000,
}

export interface BootstrapPhaseStarted {
  readonly phase: BootstrapPhaseName
  /** Set for `entry_checkout`, where a failure must name the entry (FR-112). */
  readonly entryId?: string
  readonly startedAt: Date
  readonly timeoutMs: number
}

export interface BootstrapPhaseFinished {
  readonly phase: BootstrapPhaseName
  readonly entryId?: string
  readonly outcome: BootstrapPhaseOutcome
  /** The reason, in the failing phase's own words. Never a generic string. */
  readonly detail?: string
  readonly durationMs: number
}

/**
 * Where phase progress goes.
 *
 * Two methods rather than one because the machine surface's
 * `reportBootstrapPhase` takes an outcome and a phase with no room for "this
 * one has begun" — and a start that is only reported once it has finished is
 * not a start report at all. `phaseFinished` maps one-to-one onto that
 * procedure; `phaseStarted` is what makes FR-145's live view possible. Wiring
 * both to the surface is T062 and T063's job, not this module's.
 */
export interface BootstrapPhaseReporter {
  readonly phaseStarted: (event: BootstrapPhaseStarted) => void | Promise<void>
  readonly phaseFinished: (event: BootstrapPhaseFinished) => void | Promise<void>
}

/** A reporter that discards everything. For tests only; a run must report. */
export const nullPhaseReporter: BootstrapPhaseReporter = {
  phaseStarted: () => undefined,
  phaseFinished: () => undefined,
}

/**
 * A bootstrap failure that knows which phase produced it.
 *
 * `retryable` is part of the type because one failure in this area is
 * emphatically not retryable: a digest mismatch means the bytes downloaded are
 * not the bytes registered, and downloading them again produces the same bytes.
 * Retrying it wastes instance time and, worse, implies the mismatch might be
 * transient when it is a statement about the archive.
 */
export class BootstrapPhaseError extends Error {
  readonly phase: BootstrapPhaseName
  readonly reason: string
  readonly entryId: string | undefined
  readonly retryable: boolean
  readonly timedOut: boolean

  constructor(
    phase: BootstrapPhaseName,
    reason: string,
    options: {
      readonly retryable?: boolean
      readonly entryId?: string
      readonly timedOut?: boolean
      readonly cause?: unknown
    } = {},
  ) {
    super(`bootstrap phase ${phase} failed: ${reason}`, { cause: options.cause })
    this.name = 'BootstrapPhaseError'
    this.phase = phase
    this.reason = reason
    this.entryId = options.entryId
    this.retryable = options.retryable ?? true
    this.timedOut = options.timedOut ?? false
  }

  get outcome(): BootstrapPhaseOutcome {
    return this.timedOut ? 'timed_out' : 'failed'
  }
}

export interface RunPhaseContext {
  readonly reporter: BootstrapPhaseReporter
  /** Overrides {@link DEFAULT_PHASE_TIMEOUTS} for this phase. */
  readonly timeoutMs?: number
  readonly entryId?: string
  /** Injected in tests so a duration is measured rather than slept through. */
  readonly now?: () => number
}

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/**
 * Run one phase: announce, time, bound, report.
 *
 * `execute` receives an `AbortSignal` that fires when the phase timeout
 * expires. Honouring it is how a child process gets killed instead of being
 * abandoned; a phase that ignores it still fails on time, but leaves work
 * running on an instance that is about to be torn down.
 */
export const runPhase = async <T>(
  phase: BootstrapPhaseName,
  execute: (signal: AbortSignal) => Promise<T>,
  context: RunPhaseContext,
): Promise<T> => {
  const now = context.now ?? Date.now
  const timeoutMs = context.timeoutMs ?? DEFAULT_PHASE_TIMEOUTS[phase]
  const entry = context.entryId === undefined ? {} : { entryId: context.entryId }
  const startedAtMs = now()

  await context.reporter.phaseStarted({
    phase,
    ...entry,
    startedAt: new Date(startedAtMs),
    timeoutMs,
  })

  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, timeoutMs)

  timer.unref()

  const failWith = async (error: BootstrapPhaseError): Promise<never> => {
    await context.reporter.phaseFinished({
      phase,
      // A phase covering several entries is entered without one and fails with
      // one: `entry_checkout` runs once for the whole workspace, but FR-112
      // requires the failure to name the entry that broke. Taking the id off
      // the error means the report names it without the phase having to be
      // re-entered per entry.
      ...entry,
      ...(error.entryId === undefined ? {} : { entryId: error.entryId }),
      outcome: error.outcome,
      detail: error.reason,
      durationMs: now() - startedAtMs,
    })

    throw error
  }

  try {
    const result = await Promise.race([
      execute(controller.signal),
      new Promise<never>((_resolve, rejectTimeout) => {
        controller.signal.addEventListener('abort', () => {
          rejectTimeout(
            new BootstrapPhaseError(phase, `exceeded its own timeout of ${timeoutMs}ms`, {
              ...entry,
              timedOut: true,
            }),
          )
        })
      }),
    ])

    await context.reporter.phaseFinished({
      phase,
      ...entry,
      outcome: 'succeeded',
      durationMs: now() - startedAtMs,
    })

    return result
  } catch (thrown) {
    if (thrown instanceof BootstrapPhaseError) {
      return await failWith(thrown)
    }

    // Anything else still leaves this phase named. An unexpected throw from
    // deep inside a phase is exactly when a generic bootstrap error would
    // otherwise appear, which is the thing FR-146 is written against.
    return await failWith(
      new BootstrapPhaseError(phase, describeCause(thrown), { ...entry, cause: thrown }),
    )
  } finally {
    clearTimeout(timer)
  }
}
