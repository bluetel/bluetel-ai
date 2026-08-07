/**
 * The retry policy for host requests, stated as data (T195).
 *
 * ## Why a policy object rather than a loop
 *
 * Two failure modes bracket this, and both are real:
 *
 * - **One attempt.** A single 502 from a proxy in front of the host fails a run
 *   that had already done all its work — the branch is pushed, the summary is
 *   written, and the engineer is told the delivery failed because a gateway
 *   hiccupped for 40 milliseconds.
 * - **Silent, unbounded retrying.** A run that quietly waits out a rate limit
 *   for an hour is a run nobody can tell apart from a hung one, and an instance
 *   held for an hour is billed for an hour.
 *
 * So the policy is a value: three attempts, a deterministic 250 ms doubling
 * backoff, and a hard ceiling of five seconds on any single wait. Every number
 * is a field, so a test can assert what the delay would be without waiting for
 * it, and `sleep` is injected so no test in this directory sleeps at all.
 *
 * ## Bounded even when the host names its own wait
 *
 * A rate-limited response may carry a `Retry-After` or a reset time, and it is
 * honoured — up to {@link ForgeRetryPolicy.maxDelayMs}. Past that the request is
 * **not** retried and the rate-limited error is thrown. Waiting out a
 * thirty-minute reset would be indistinguishable from a hang; failing with
 * `rate_limited` and the host's own figure is something an operator can read
 * off the panel and act on.
 *
 * ## Deterministic, and no jitter
 *
 * Jitter exists to de-synchronise a fleet of clients hammering one endpoint.
 * There is one executor per run and at most a handful of host calls in the
 * whole delivery path, so it would buy nothing and cost the ability to state
 * exactly what this does.
 *
 * ## What is retried is decided elsewhere
 *
 * {@link isRetryableForgeError} — only `rate_limited` and `transient`. In
 * particular a `conflict` is never retried, because the conflict a creation can
 * hit is "that pull request already exists", and the answer to it is to look
 * again rather than to ask again (FR-077).
 */

import { isRetryableForgeError } from './forge-error'

export interface ForgeRetryPolicy {
  /** Total attempts including the first. `1` disables retrying. */
  readonly maxAttempts: number
  /** First backoff; each subsequent one doubles. */
  readonly baseDelayMs: number
  /** Ceiling on any single wait, including one the host asked for. */
  readonly maxDelayMs: number
  /** Injected so no test waits. Defaults to a real timer. */
  readonly sleep?: (milliseconds: number) => Promise<void>
}

export const DEFAULT_FORGE_RETRY_POLICY: ForgeRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 5000,
}

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds)
  })

/**
 * How long to wait before attempt `attempt + 1`, or `undefined` for "do not".
 *
 * The whole policy is decidable from this one pure function, which is what
 * makes "state your retry policy and make it testable" satisfiable: the
 * colocated test asserts every branch of it without a timer.
 *
 * @param policy - The attempt budget and the delays.
 * @param attempt - The 1-based attempt that just failed.
 * @param error - What it failed with.
 * @returns The wait in milliseconds, or `undefined` when the failure must stand.
 */
export const forgeRetryDelayMs = (
  policy: ForgeRetryPolicy,
  attempt: number,
  error: unknown,
): number | undefined => {
  if (attempt >= policy.maxAttempts) {
    return undefined
  }

  if (!isRetryableForgeError(error)) {
    return undefined
  }

  // The host named its own wait. Honour it, or refuse the retry outright —
  // never silently shorten it, which would spend the attempt on a request the
  // host has already said it will refuse.
  if (error.retryAfterMs !== undefined) {
    return error.retryAfterMs > policy.maxDelayMs ? undefined : error.retryAfterMs
  }

  return Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs)
}

/**
 * Run an operation under the policy.
 *
 * `run` is called afresh on every attempt rather than being a promise to await
 * twice, which matters for creation: each attempt of
 * `./forge-http.ts`'s creation re-reads the host before it posts, so a retry
 * cannot open a second pull request (FR-077).
 *
 * @param policy - The policy to apply.
 * @param run - The operation, given its 1-based attempt number.
 * @returns Whatever `run` resolved with.
 * @throws The last failure, unchanged, once the budget is spent.
 */
export const withForgeRetry = async <TResult>(
  policy: ForgeRetryPolicy,
  run: (attempt: number) => Promise<TResult>,
): Promise<TResult> => {
  const sleep = policy.sleep ?? defaultSleep
  let attempt = 0

  for (;;) {
    attempt += 1

    try {
      return await run(attempt)
    } catch (failure) {
      const delay = forgeRetryDelayMs(policy, attempt, failure)

      if (delay === undefined) {
        throw failure
      }

      await sleep(delay)
    }
  }
}
