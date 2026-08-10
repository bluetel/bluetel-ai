/**
 * **How long a paused run may sit untouched before the platform parks it** (003/FR-044, FR-047,
 * FR-049, US2 §4).
 *
 * ## Why this number lives in a package and not in an application
 *
 * Three members enforce it, and none of them can import either of the others:
 *
 * | Member | What it does with the number |
 * | --- | --- |
 * | `apps/sisyphus-executor/src/session/idle-ceiling.ts` | counts it down in-process, and hands the instance back at zero |
 * | `apps/sisyphus-control-plane/src/jobs/reconcile.ts` | enforces it from outside, plus a grace, for the executor that could not |
 * | `apps/sisyphus-admin/src/components/workflows/parking-countdown.ts` | shows the run's owner how long they have left |
 *
 * Until this module existed there were three copies of `30 * 60 * 1000`, one per application, each
 * with a comment apologising for the other two. That is a number deciding when somebody's working
 * tree is destroyed, held in three places that no test compares — so a deployment could tune the
 * platform's behaviour and leave the panel counting down to a deadline nothing was working to, or
 * move the panel's copy and have the run park while the screen said sixteen minutes remained.
 *
 * `contracts/` is the shared home because it is the only one all three can reach: browser-safe by
 * construction, no runtime dependency any of them cannot bundle, and already the place where the
 * executor protocol and the credential rotation shapes live for exactly this reason. `src/enums/`
 * was the other candidate and is wrong — this is a duration, not a closed vocabulary, and nothing
 * validates against it.
 *
 * ## What each member still owns
 *
 * The **reasoning** for the value stays in the executor's `idle-ceiling.ts`, which is where the
 * clock that normally fires it lives; the reasoning for the reconciler's extra grace stays in
 * `reconcile.ts`, because the grace is a fact about two enforcers racing rather than about the
 * limit. Both are still free to be handed a different value — every consumer takes it as an
 * optional parameter — which is what lets a suite state the limit it is testing without moving the
 * one the platform runs on.
 *
 * ## Why it is a constant rather than configuration
 *
 * It is not deployment-tunable today, and making it so would mean the panel could not know it
 * without asking the server: `toParkingCountdownReadout` renders in the browser, and a countdown
 * that had to wait for a round trip would show nothing on first paint. If it ever becomes
 * configuration, the honest shape is a value the server sends alongside the run — and this constant
 * becomes the default that value falls back to, in one place, rather than three literals to find.
 */

/** Milliseconds in a minute. Named so the ceiling below reads as the quantity it is. */
const MILLISECONDS_PER_MINUTE = 60_000

/**
 * Thirty minutes.
 *
 * Chosen against what a pause is *for*: somebody reading output and deciding what to correct, which
 * is minutes. Thirty covers a meeting or a lunch without the engineer losing their place, because
 * parking is not a failure and a resume restores the same conversation onto a fresh instance. Much
 * shorter and an ordinary interruption costs a restore cycle; much longer and a forgotten pause
 * bills an idle instance for an afternoon.
 */
export const PAUSE_IDLE_CEILING_MS = 30 * MILLISECONDS_PER_MINUTE
