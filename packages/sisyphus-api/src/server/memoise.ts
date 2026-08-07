/**
 * Per-request memoisation of an async lookup.
 *
 * The request context resolves several things lazily — the caller's visible profile set, the
 * executor's workflow-scoped credential — because most requests consult none of them. Lazy alone
 * is not enough: a scoped list that runs three queries must not run three grants lookups. So the
 * pattern is "resolve at most once, only if asked", and it is written here once rather than
 * repeated per resolver.
 */

/**
 * Wrap a loader so it runs at most once.
 *
 * The **promise** is cached, not its resolved value, so two concurrent callers share one in-flight
 * lookup rather than starting two. A rejection is cached too: within a single request a failed
 * lookup must keep failing, because a silent retry that succeeds the second time would build a
 * response from two different answers to the same question.
 *
 * @param load - The lookup. Invoked at most once per returned function.
 * @returns A function returning the memoised promise.
 */
export const memoiseAsync = <T>(load: () => Promise<T>): (() => Promise<T>) => {
  let pending: Promise<T> | undefined
  return () => {
    pending ??= load()
    return pending
  }
}
