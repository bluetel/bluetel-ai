/**
 * The outbound check behind FR-124's enable gate — as a seam, not as an implementation.
 *
 * FR-124 will not let an execution profile be enabled until validation confirms that every
 * workspace entry's repository and base branch are **reachable with the credentials available**.
 * That is inherently an outbound call, and an outbound call reached directly from a resolver is a
 * resolver no test can exercise: the suite either provisions a real repository and a real
 * credential, or the requirement goes untested and ships broken.
 *
 * So the check is one method behind one interface, in the same shape as the four seams in
 * `apps/sisyphus-control-plane/src/aws/`: the interface states what the gate *does* with a host —
 * "can this branch of this repository be read?" — rather than re-exporting whatever a git host's
 * API offers. `reachability-fake.ts` ships the recording fake, so no test in this package makes a
 * network call.
 *
 * ## What a real implementation calls
 *
 * The cheapest honest answer is a credentialed `git ls-remote --heads <repositoryUrl> <baseBranch>`
 * — one round trip, no clone, and it proves the three things that matter together: the host
 * resolves, the credential authenticates, and the named branch exists. A non-empty ref list is
 * `reachable`; empty means the repository was readable but the branch is not there, which is a
 * different message for the admin than a 404 on the repository itself. That runs where the git
 * credential lives — the control plane, not the panel's request path — so the adapter this package
 * would be handed is a client of that, rather than a `child_process` call from a Lambda that has
 * neither git nor the credential.
 *
 * The REST equivalent, where a host offers one, is a single branch read: GitHub
 * `GET /repos/{owner}/{repo}/branches/{branch}`, whose 200/404/401 map onto the three outcomes
 * directly.
 */

/** One repository and branch, as a workspace entry names them. */
export interface ReachabilityTarget {
  readonly repositoryUrl: string
  readonly baseBranch: string
}

/**
 * What a probe answers.
 *
 * The failure carries a `reason` because the gate's whole value is naming what to fix: "unreachable"
 * and "unreachable: the credential cannot read this repository" send an admin to different places.
 */
export type ReachabilityOutcome =
  | { readonly reachable: true }
  | { readonly reachable: false; readonly reason: string }

/**
 * The seam. One method, deliberately.
 *
 * A wider interface — list branches, read the default branch, check permissions — would be a git
 * host client, and every implementation would have to satisfy parts of it the gate never calls.
 */
export interface RepositoryReachabilityProbe {
  readonly check: (target: ReachabilityTarget) => Promise<ReachabilityOutcome>
}

/** The reason given when no probe has been wired into the deployment. */
export const REACHABILITY_NOT_CONFIGURED_REASON =
  'this deployment has no repository reachability checker configured, so reachability cannot be confirmed'

/**
 * The probe used when a deployment has wired none.
 *
 * It reports **every** target as unreachable, which refuses every `setEnabled(true)`. That is the
 * safe default rather than an inconvenient one: FR-124 exists to stop a profile whose repositories
 * cannot be checked out reaching a run, and a probe that answered "reachable" when it had checked
 * nothing would convert the gate into a formality while leaving it looking present. A deployment
 * that wants to be able to enable profiles supplies a real probe to `createProfilesRouter`.
 */
export const createRefusingReachabilityProbe = (): RepositoryReachabilityProbe => ({
  check: () => Promise.resolve({ reachable: false, reason: REACHABILITY_NOT_CONFIGURED_REASON }),
})

/** One target's verdict, kept alongside the target so a caller can name what failed. */
export interface ReachabilityReport {
  readonly target: ReachabilityTarget
  readonly outcome: ReachabilityOutcome
}

/**
 * Probe every target, keeping the results in the order they were given.
 *
 * Every target is probed even after one fails, so an admin fixing a workspace sees the whole list
 * of broken entries at once rather than discovering them one enable attempt at a time.
 *
 * A probe that rejects is treated as a failed check rather than allowed to escape: a transport
 * error is exactly the state FR-124 refuses to enable through, and letting it become a 500 would
 * lose the entry it happened on.
 */
export const probeTargets = async (
  probe: RepositoryReachabilityProbe,
  targets: readonly ReachabilityTarget[],
): Promise<readonly ReachabilityReport[]> =>
  Promise.all(
    targets.map(async (target): Promise<ReachabilityReport> => {
      try {
        return { target, outcome: await probe.check(target) }
      } catch (error) {
        return {
          target,
          outcome: {
            reachable: false,
            reason: error instanceof Error ? error.message : 'the reachability check failed',
          },
        }
      }
    }),
  )
