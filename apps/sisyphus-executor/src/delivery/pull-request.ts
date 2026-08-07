/**
 * Draft pull request creation (T069, FR-060, FR-077, FR-153).
 *
 * ## Pushed-commit verification is the reason this module exists
 *
 * An agent that reports success on an unpushed branch is the failure this
 * catches, and it is not a hypothetical one: a `git push` can fail on a
 * protected branch, on a rejected non-fast-forward, on an expired credential,
 * or simply never be run — and every one of those leaves a local repository
 * that looks exactly like a successful run. The pull request is then opened
 * against a branch the host does not have, or against yesterday's version of
 * one, and the engineer is told their work is ready for review.
 *
 * So nothing is claimed until three things are true, checked against the forge
 * rather than against the working copy:
 *
 * 1. The host **has** the branch at all.
 * 2. What the host has at that branch is **exactly the local `HEAD`**. Not an
 *    ancestor of it, not a descendant — the same commit. An ancestor means the
 *    last commits never left the instance; a descendant means something else
 *    is pushing to this branch and the run does not know what it is proposing.
 * 3. The host's branch has **moved since the run started**, measured against
 *    the pre-execution remote sha recorded before any agent work began. A
 *    branch that already existed at exactly this commit means this run pushed
 *    nothing, and a pull request for it would attribute someone else's work to
 *    this run.
 *
 * When any of those fails the module throws, naming the shas, and **no pull
 * request is created**. Reporting a failure the engineer can act on is the
 * point; opening the pull request anyway and letting them discover it is the
 * behaviour being prevented.
 *
 * ## Draft, and no ticket transition
 *
 * FR-060: a delegated workflow opens the pull request **as a draft unless the
 * request explicitly says otherwise**, and performs **no** ticket transition.
 * Draft is therefore the default and `readyForReview` is the only thing that
 * changes it. The ticket rule needs no code at all, which is the point — the
 * {@link Forge} port has no method that could transition one, so there is no
 * expression in this file that does, and the result says so explicitly rather
 * than leaving a reader to infer it from an absence.
 *
 * ## Idempotency
 *
 * FR-077. The host gets a derived {@link pullRequestIdempotencyKey}, and the
 * module looks for an existing pull request before creating one, so a retry
 * after a lost response returns the pull request that already exists instead
 * of opening a second.
 */

import type { ReviewerSummary } from '../report'

import type { DeliveryConventions } from './conventions'
import type { Forge, PullRequestRef } from './forge'
import { pullRequestIdempotencyKey } from './forge'
import type { GitReader } from './git'

/** The step named in a halt, per FR-058. */
export const DELIVERY_STEP = 'draft pull request'

export interface OpenDraftPullRequestInput {
  readonly workflowId: string
  readonly repository: string
  /** Every branch, base and title comes from here. Nothing is defaulted. */
  readonly conventions: DeliveryConventions
  /**
   * What the host had at the work branch **before** the run started, recorded
   * at checkout. `undefined` means the branch did not exist, which is the
   * ordinary case for a new piece of work.
   */
  readonly preExecutionRemoteSha?: string
  /** Included in the description, because FR-153 requires it there. */
  readonly summary: ReviewerSummary
  /**
   * FR-060's explicit override. Absent or false means draft; only an explicit
   * request opens a pull request ready for review.
   */
  readonly readyForReview?: boolean
  readonly git: GitReader
  readonly forge: Forge
}

export interface PullRequestDelivery {
  readonly pullRequest: PullRequestRef
  /** The commit the host was verified to hold at the work branch. */
  readonly verifiedSha: string
  /** True when an existing pull request was returned rather than created. */
  readonly alreadyExisted: boolean
  /**
   * Always `false`. FR-060 leaves the ticket with the initiating engineer, and
   * recording the fact is what lets the panel and the timeline show that the
   * ticket was deliberately untouched rather than missed.
   */
  readonly ticketTransitioned: false
}

const short = (sha: string): string => sha.slice(0, 12)

/** The host has no such branch: the push never happened. */
export const branchNotOnForgeError = (branch: string, localHead: string): Error =>
  new Error(
    `The work branch ${branch} is not on the forge, so the commit ${short(localHead)} was never ` +
      'pushed. No pull request was opened.',
  )

/** The host has the branch, but not at the commit the run produced. */
export const unpushedCommitError = (branch: string, localHead: string, remoteHead: string): Error =>
  new Error(
    `The forge has ${branch} at ${short(remoteHead)} but the run produced ${short(localHead)}, so ` +
      'the work did not reach the remote. No pull request was opened.',
  )

/** The host's branch is exactly where it was before the run: nothing landed. */
export const noPushedWorkError = (branch: string, sha: string): Error =>
  new Error(
    `The forge still has ${branch} at ${short(sha)}, the commit it held before this run started, ` +
      'so this run pushed nothing. No pull request was opened.',
  )

/**
 * Prove the work reached the forge.
 *
 * @param input - The branch to verify, the sha it held beforehand, and the ports.
 * @returns The commit the forge was verified to hold.
 */
const verifyPushedCommit = async (input: OpenDraftPullRequestInput): Promise<string> => {
  const branch = input.conventions.branchName
  const localHead = await input.git.headSha()
  const remoteHead = await input.forge.branchHead({ repository: input.repository, branch })

  if (remoteHead === undefined) {
    throw branchNotOnForgeError(branch, localHead)
  }

  if (remoteHead !== localHead) {
    throw unpushedCommitError(branch, localHead, remoteHead)
  }

  if (input.preExecutionRemoteSha !== undefined && input.preExecutionRemoteSha === remoteHead) {
    throw noPushedWorkError(branch, remoteHead)
  }

  return remoteHead
}

const composeBody = (input: OpenDraftPullRequestInput): string =>
  input.conventions.bodyPreamble === undefined
    ? input.summary.markdown
    : `${input.conventions.bodyPreamble.trim()}\n\n${input.summary.markdown}`

/**
 * Verify the push, then open (or find) the draft pull request.
 *
 * @param input - The run, its skill-derived conventions, and the two ports.
 * @returns The pull request, the verified commit, and the untouched ticket.
 */
export const openDraftPullRequest = async (
  input: OpenDraftPullRequestInput,
): Promise<PullRequestDelivery> => {
  const verifiedSha = await verifyPushedCommit(input)

  const head = input.conventions.branchName
  const base = input.conventions.baseBranch
  const existing = await input.forge.findPullRequest({
    repository: input.repository,
    head,
    base,
  })

  if (existing !== undefined) {
    return { pullRequest: existing, verifiedSha, alreadyExisted: true, ticketTransitioned: false }
  }

  const pullRequest = await input.forge.createPullRequest({
    repository: input.repository,
    head,
    base,
    title: input.conventions.pullRequestTitle,
    body: composeBody(input),
    // FR-060: draft unless the request explicitly said otherwise.
    draft: input.readyForReview !== true,
    idempotencyKey: pullRequestIdempotencyKey({
      workflowId: input.workflowId,
      repository: input.repository,
      head,
      base,
    }),
  })

  return { pullRequest, verifiedSha, alreadyExisted: false, ticketTransitioned: false }
}
