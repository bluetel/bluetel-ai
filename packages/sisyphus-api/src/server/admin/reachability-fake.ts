import type {
  ReachabilityOutcome,
  ReachabilityTarget,
  RepositoryReachabilityProbe,
} from './reachability'

/**
 * Recording fake for {@link RepositoryReachabilityProbe}.
 *
 * **Test support, and the only probe any test in this package uses.** FR-124's gate is the check
 * that stops a profile/bundle mismatch reaching a run, so it has to be exercised against every
 * answer a real host can give — reachable, missing branch, refused credential, transport failure —
 * and none of those are reproducible against a real repository inside a unit test.
 *
 * Calls are recorded in order, because "the gate stopped at the first bad entry" and "the gate
 * checked them all and reported the second" are different behaviours and only the recording tells
 * them apart.
 */

export interface FakeReachabilityProbe extends RepositoryReachabilityProbe {
  /** Every target passed to `check`, in call order. */
  readonly calls: readonly ReachabilityTarget[]
  /** Make one repository answer differently from the default. Keyed by repository URL. */
  readonly setOutcome: (repositoryUrl: string, outcome: ReachabilityOutcome) => void
  /** Make `check` reject, for the transport-failure path. */
  readonly failWith: (repositoryUrl: string, error: Error) => void
}

export interface FakeReachabilityProbeOptions {
  /** What a repository with no outcome set answers. Reachable, so a test states its own problem. */
  readonly defaultOutcome?: ReachabilityOutcome
}

export const createFakeReachabilityProbe = (
  options: FakeReachabilityProbeOptions = {},
): FakeReachabilityProbe => {
  const calls: ReachabilityTarget[] = []
  const outcomes = new Map<string, ReachabilityOutcome>()
  const failures = new Map<string, Error>()
  const defaultOutcome: ReachabilityOutcome = options.defaultOutcome ?? { reachable: true }

  return {
    calls,

    setOutcome: (repositoryUrl, outcome) => {
      outcomes.set(repositoryUrl, outcome)
    },

    failWith: (repositoryUrl, error) => {
      failures.set(repositoryUrl, error)
    },

    check: (target) => {
      calls.push(target)

      const failure = failures.get(target.repositoryUrl)
      if (failure !== undefined) {
        return Promise.reject(failure)
      }

      return Promise.resolve(outcomes.get(target.repositoryUrl) ?? defaultOutcome)
    },
  }
}
