import { REPLAY_WINDOW_MS } from './verify-signature'

/**
 * Rejecting a delivery the platform has already accepted (T122, FR-017, FR-077).
 *
 * ## Two halves, and only one of them can be skipped
 *
 * The timestamp window in `verify-signature.ts` bounds *how long* a captured delivery stays useful.
 * It cannot stop a replay inside that window, because a replayed request is byte-identical to the
 * original and therefore verifies. That is what this is for: a signature already seen is refused.
 *
 * Together they are the whole guarantee. The window is what lets the seen-set be **bounded** —
 * entries older than the window can be dropped, because a delivery that old is refused before it
 * gets here — so this never has to remember every delivery the platform has ever received.
 *
 * ## The default store is per-instance, and that is stated rather than assumed
 *
 * {@link createMemoryReplayStore} holds seen signatures in the process. In a serverless deployment
 * that means a replay landing on a *different* instance inside the window is not caught. The
 * interface exists so a deployment can supply a shared store — Redis, or a table with a unique
 * index on the signature and a TTL — and the route takes one rather than importing one, so making
 * that swap is a line at the composition root.
 *
 * Claiming a per-instance cache is a complete replay defence would be worse than not having one,
 * because it would stop anyone looking; the honest statement is that the durable half is the
 * window, and the seen-set narrows it further by however much the deployment's store is shared.
 */

export interface ReplayStore {
  /**
   * Record a signature and say whether it was **new**.
   *
   * One call rather than `has` then `add`: two calls are a race, and the race is exactly the
   * concurrent double-delivery this exists to catch.
   */
  readonly claim: (signature: string, now: number) => Promise<boolean>
}

/**
 * A bounded in-process store.
 *
 * @param windowMs - How long a signature is remembered. Defaults to the verification window,
 *   because a delivery older than that is refused before it reaches here.
 */
export const createMemoryReplayStore = (windowMs: number = REPLAY_WINDOW_MS): ReplayStore => {
  const seen = new Map<string, number>()

  return {
    claim: (signature, now) => {
      // Swept on every claim rather than on a timer: a timer in a serverless runtime is a handle
      // that keeps an instance alive, and the map only grows while requests are arriving anyway.
      for (const [key, at] of seen) {
        if (now - at > windowMs) {
          seen.delete(key)
        }
      }

      if (seen.has(signature)) {
        return Promise.resolve(false)
      }

      seen.set(signature, now)

      return Promise.resolve(true)
    },
  }
}
