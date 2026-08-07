/**
 * **The pause idle ceiling (T181, FR-049, FR-050, US2 §4, quickstart Scenario 5.6).**
 *
 * `suspend()`'s pause plan says `computeRelease: 'on-idle-ceiling'`. Until this module existed that
 * value had exactly one consumer — `plan.computeRelease === 'immediate'` — so all it meant was
 * *don't release the instance*, with nothing anywhere that would ever release it later. A pause was
 * therefore an instance held open until a person came back, or for ever if they did not. This is
 * the "later" the plan was referring to.
 *
 * ## What the requirement actually asks for
 *
 * US2 §4: *given a paused workflow, when nobody interacts with it for the configured idle limit,
 * the workflow is snapshotted, marked resumable, its instance is released, and the engineer is told
 * it was parked rather than failed.* Three of those four are already true the moment the pause
 * completes — FR-049 makes the pause snapshot the working tree and register it **before** the pause
 * is acknowledged, so a paused run is a resumable run by construction. What was missing is the
 * clock, and the release at the end of it.
 *
 * ## Why the executor holds the clock, and why it is not the only thing that does
 *
 * The instance is the thing costing money, so the instance is the thing that should give itself
 * back: it needs no round trip, no sweep interval, and it works while the control plane is
 * unreachable. But an executor that has crashed, hung, or had its instance reclaimed cannot
 * release anything, and that is precisely the case where an instance is left running with nobody
 * watching. So `apps/sisyphus-control-plane/src/jobs/reconcile.ts` enforces the **same** ceiling
 * against the durable `paused` timeline row, plus a grace period — deliberately later than this
 * one, so the common case is settled locally and the reconciler only ever acts on an executor that
 * did not.
 *
 * There is no `workflows.paused_at` column and this design does not need one: the timeline already
 * records a `paused` event with a `created_at`, written once per pause inside
 * `acknowledgeSupervisionCommand`'s transaction. Adding a column would have been a second copy of
 * a fact the platform already stores, with the usual consequence of the two disagreeing.
 *
 * ## Not a re-snapshot
 *
 * Expiry does not take a second snapshot, and that is not an omission. The agent has been quiesced
 * since the pause, no turn has been sent, and nothing has touched the working tree — so a fresh
 * capture would write byte-identical content under a new key and cost a second archive upload at
 * the exact moment the run is trying to release its compute. The pause's snapshot is the state, and
 * it is already registered as current.
 */

/**
 * How long a paused run may sit untouched before its instance is handed back.
 *
 * Thirty minutes, chosen against what a pause is *for*. A pause is somebody reading output and
 * deciding what to correct, which is minutes; thirty covers a meeting or a lunch without the
 * engineer losing their place, because parking is not a failure and a resume restores the same
 * conversation onto a fresh instance (FR-053). Much shorter and an ordinary interruption costs a
 * restore cycle; much longer and a forgotten pause bills an idle instance for an afternoon, which
 * is the same silent-cost failure SC-007 exists to prevent.
 */
export const PAUSE_IDLE_CEILING_MS = 30 * 60 * 1000

/** What expiry reports: when the pause started, how long it ran, and what it ran past. */
export interface PauseIdleExpiry {
  readonly pausedAt: Date
  readonly idleMs: number
  readonly ceilingMs: number
}

export interface PauseIdleCeilingOptions {
  /** Defaults to {@link PAUSE_IDLE_CEILING_MS}. */
  readonly ceilingMs?: number
  /** Injectable clock, so a test measures rather than waits. */
  readonly now?: () => Date
}

export interface PauseIdleCeiling {
  /**
   * Start counting.
   *
   * @param pausedAt - When the pause began — `SuspendResult.suspendedAt`. The remaining time is
   *   measured from *that* moment rather than from this call, so the seconds the platform spent
   *   reaching a turn boundary and writing a snapshot are not silently added to the engineer's
   *   allowance.
   */
  readonly begin: (pausedAt: Date) => void
  /** Stop counting: the run was resumed, stopped, or is ending for some other reason. */
  readonly cancel: () => void
  /** When the current pause began, or `undefined` when nothing is being counted. */
  readonly pausedAt: () => Date | undefined
  /** When the instance will be handed back, or `undefined` when nothing is being counted. */
  readonly expiresAt: () => Date | undefined
  /**
   * Resolves once — and only if — a pause outlives the ceiling.
   *
   * A promise rather than a callback because the caller races it against the workflow, exactly as
   * it races the interruption watch: an expiry ends the run, so it belongs in the same
   * `Promise.race` as the other two things that can. It never resolves for a run that is never
   * paused, which is what makes it safe to include in that race unconditionally.
   */
  readonly expired: Promise<PauseIdleExpiry>
}

/**
 * A clock that hands the instance back when a pause is left alone for too long.
 *
 * @param options - The ceiling in force and the clock to measure it with.
 * @returns The ceiling, not yet counting. {@link PauseIdleCeiling.begin} starts it.
 */
export const createPauseIdleCeiling = (options: PauseIdleCeilingOptions = {}): PauseIdleCeiling => {
  const ceilingMs = options.ceilingMs ?? PAUSE_IDLE_CEILING_MS
  const now = options.now ?? ((): Date => new Date())

  let timer: ReturnType<typeof setTimeout> | undefined
  let startedAt: Date | undefined
  let settled = false
  let resolveExpiry: (expiry: PauseIdleExpiry) => void = () => undefined

  const expired = new Promise<PauseIdleExpiry>((resolve) => {
    resolveExpiry = resolve
  })

  const clear = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  return {
    expired,
    begin: (pausedAt) => {
      if (settled) {
        return
      }

      clear()
      startedAt = pausedAt

      // Clamped at zero: a pause whose snapshot parked for longer than the whole ceiling has
      // already outlived it, and should expire on the next tick rather than never.
      const remainingMs = Math.max(0, ceilingMs - (now().getTime() - pausedAt.getTime()))

      timer = setTimeout(() => {
        settled = true
        timer = undefined
        resolveExpiry({
          pausedAt,
          idleMs: now().getTime() - pausedAt.getTime(),
          ceilingMs,
        })
      }, remainingMs)
      // A pause ceiling must not be the reason a finished process refuses to exit.
      timer.unref()
    },
    cancel: () => {
      clear()
      startedAt = undefined
    },
    pausedAt: () => startedAt,
    expiresAt: () =>
      startedAt === undefined ? undefined : new Date(startedAt.getTime() + ceilingMs),
  }
}

/**
 * The reason a run reports when the ceiling expires.
 *
 * A sentence rather than a code, because it is what the engineer reads in the panel and "parked,
 * not failed" is the whole point of US2 §4 — a person who cannot tell the two apart will assume
 * their work is gone.
 *
 * @param expiry - What {@link PauseIdleCeiling.expired} resolved with.
 */
export const pauseIdleCeilingReason = (expiry: PauseIdleExpiry): string =>
  `this run was paused at ${expiry.pausedAt.toISOString()} and left idle for ` +
  `${String(Math.round(expiry.idleMs / 1000))}s, past the ` +
  `${String(Math.round(expiry.ceilingMs / 1000))}s pause idle ceiling. Its instance has been ` +
  'handed back. Nothing was lost and nothing failed: the conversation and the working tree were ' +
  'snapshotted and registered when the pause was taken, so resuming continues from exactly there ' +
  '(FR-049, FR-050, US2 §4).'
