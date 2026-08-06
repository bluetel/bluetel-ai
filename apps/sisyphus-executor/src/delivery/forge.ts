/**
 * The forge seam — everything the delivery path may ask of a code host (T069).
 *
 * Three methods, and the shape of the interface is as much of the design as
 * the shape of any one of them:
 *
 * - **It is an interface, not a client.** There is no GitHub SDK in this
 *   application. Putting the host behind a port means the delivery tests run
 *   against a fake and never open a socket, and it means the eventual REST
 *   implementation is one file that nothing else knows about.
 * - **It cannot transition a ticket.** FR-060 says a delegated workflow leaves
 *   delivery ownership with the initiating engineer and performs **no** ticket
 *   transition. That is the whole promise of US1 — the engineer keeps the
 *   ticket — so it is enforced by there being no method to do it with, in the
 *   same way the git port has no method that rebases. A future review or
 *   integration workflow that legitimately transitions a ticket (FR-061,
 *   FR-063) gets its own port; it does not get added to this one.
 * - **Creation is idempotent.** FR-077 requires that a retried external action
 *   cannot produce a duplicate. The host is given an
 *   {@link pullRequestIdempotencyKey}, and the delivery path also looks before
 *   it creates, because a host that ignores the key must not be able to open
 *   two pull requests for one run.
 */

export interface PullRequestRef {
  readonly number: number
  readonly url: string
  readonly isDraft: boolean
}

export interface CreatePullRequestInput {
  readonly repository: string
  /** Branch carrying the work, per the skill's convention. */
  readonly head: string
  /** Branch it is proposed onto, per the skill's convention. */
  readonly base: string
  readonly title: string
  readonly body: string
  readonly draft: boolean
  /** Stable across retries of the same run (FR-077). */
  readonly idempotencyKey: string
}

export interface Forge {
  /**
   * The commit the host currently has at `branch`, or `undefined` if it has no
   * such branch. This is the question pushed-commit verification turns on: the
   * host that will be asked to open the pull request is the one that has to be
   * able to see the commit.
   */
  readonly branchHead: (input: {
    readonly repository: string
    readonly branch: string
  }) => Promise<string | undefined>

  /** An open pull request already proposing `head` onto `base`, if any. */
  readonly findPullRequest: (input: {
    readonly repository: string
    readonly head: string
    readonly base: string
  }) => Promise<PullRequestRef | undefined>

  readonly createPullRequest: (input: CreatePullRequestInput) => Promise<PullRequestRef>
}

/**
 * A key that is the same on every attempt of one run's delivery and different
 * for any other.
 *
 * Derived rather than random for exactly that reason: a retry that generated a
 * fresh key would be indistinguishable from a new request, which is the
 * duplicate FR-077 exists to prevent. The workflow id is the run's identity
 * and the branch pair is the action's, so the two together name "this run's
 * pull request from this branch onto that one" and nothing else.
 *
 * @param input - The run and the branch pair the pull request proposes.
 * @returns The idempotency key to send with creation.
 */
export const pullRequestIdempotencyKey = (input: {
  readonly workflowId: string
  readonly repository: string
  readonly head: string
  readonly base: string
}): string => ['pull-request', input.workflowId, input.repository, input.head, input.base].join(':')
