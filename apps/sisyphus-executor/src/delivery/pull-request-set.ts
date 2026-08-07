/**
 * One pull request per entry, sharing one branch name (T105, FR-115, FR-116).
 *
 * ## This composes the single-entry path; it does not restate it
 *
 * Everything that makes a pull request trustworthy already lives in
 * `./pull-request.ts`: pushed-commit verification against the pre-execution
 * remote sha, draft-unless-asked, no ticket transition, look-before-create. A
 * set is not a second delivery mechanism with its own opinions about those
 * things — it is that mechanism, run once per entry, with three additions a
 * single repository does not need.
 *
 * ### One branch name, from the primary entry's skill (FR-116)
 *
 * The shared branch is `conventions.branchName`, and the conventions are the
 * ones `sisyphus-dev` gave the **primary** entry. Not derived per repository:
 * the branch name is what a reviewer looking at any one of these pull requests
 * uses to find the rest, and a set that named its branches independently would
 * have no such handle. The *base* is per entry, because each repository states
 * its own — a client whose library releases from `develop` and whose service
 * deploys from `main` is ordinary, and taking the primary's base for all of
 * them would propose changes onto branches nobody named.
 *
 * ### Each cross-references the others (FR-116)
 *
 * A reviewer must see the whole set from any one of them, and the pull requests
 * cannot reference one another by URL: none exists until it is created, and the
 * {@link Forge} port has no method to edit a description afterwards — for the
 * same reason it has no method to transition a ticket. So the cross-reference
 * is written from what **is** known before anything is created: the shared
 * branch, every repository in the set, and each one's position in the
 * integration order. That is a stronger handle than a list of links would be,
 * because it is identical on all of them and stays correct if one is closed.
 *
 * ### One entry failing does not unmake the others (FR-118)
 *
 * Every entry is attempted, and a failure is recorded against that entry rather
 * than thrown out of the set. Two reasons, and the second is the one that
 * decides it:
 *
 * - There is nothing to roll back **to**. A pull request that has been opened
 *   is visible to the customer, and the forge port cannot close one.
 * - FR-118 requires the workflow to record a per-entry result and reach a
 *   terminal outcome that *states* the partial state. A set that stopped at the
 *   first failure would have no result at all for the entries after it, and
 *   "not attempted" and "failed" would be indistinguishable.
 *
 * So the caller gets every entry's outcome and {@link PullRequestSet.isPartial}
 * to hand to the terminal report. What it must not do with that is report plain
 * success, which is why the shape makes the partial case impossible to overlook
 * rather than a field that reads `true` by accident.
 *
 * ### Idempotency is the general mechanism, not a local one
 *
 * Each entry's attempt goes through `./external-action.ts` under the identity
 * `pullRequestIdentity`, so a set retried after a partial failure replays the
 * pull requests it already has instead of opening second copies, and a halt can
 * name what was left pending (FR-076, FR-077).
 *
 * It is deliberately registered **without** a `find`. `performExternalAction`
 * would otherwise ask the forge for an existing pull request *before* the
 * attempt runs — which is before this run has proved its work reached the
 * branch. A pull request that happens to exist on a branch of this name is not
 * evidence that this run pushed anything, and returning it would be exactly the
 * misattribution `./pull-request.ts` verifies against. The look-before-create
 * still happens; it happens inside `openDraftPullRequest`, after verification,
 * which is the only order in which its answer means anything.
 */

import type { ReviewerSummary } from '../report'

import type { DeliveryConventions } from './conventions'
import type { ExternalActionLedger } from './external-action'
import {
  createExternalActionLedger,
  performExternalAction,
  pullRequestIdentity,
} from './external-action'
import type { Forge, PullRequestRef } from './forge'
import type { GitReader } from './git'
import type { DeclaredPromotionOrder } from './promotion-order'
import { requirePromotionOrder } from './promotion-order'
import type { PullRequestDelivery } from './pull-request'
import { openDraftPullRequest } from './pull-request'

/** The step named in a halt for the set, per FR-058. */
export const PULL_REQUEST_SET_STEP = 'draft pull request set'

/** One entry of the workspace, as the delivery path sees it. */
export interface PullRequestSetEntry {
  readonly entryId: string
  readonly repository: string
  /**
   * The branch this entry's work is proposed onto — **this repository's**, from
   * the workspace entry that declared it (FR-109). Never the primary's.
   */
  readonly baseBranch: string
  /**
   * What the forge had at the shared work branch before the run started.
   * `undefined` means it had no such branch, the ordinary case for new work.
   */
  readonly preExecutionRemoteSha?: string
  /**
   * Whether the agent changed anything in this repository. `false` opens no
   * pull request at all — FR-115 allows **at most** one per entry, and an empty
   * one would ask a reviewer to look at nothing.
   */
  readonly wasChanged: boolean
  readonly git: GitReader
  readonly forge: Forge
}

/** What happened to one entry. */
export type PullRequestSetOutcome =
  /** A pull request exists for this entry, opened now or found already open. */
  | 'opened'
  /** The agent changed nothing here, so nothing was proposed. */
  | 'unchanged'
  /** This entry was attempted and did not produce a pull request. */
  | 'failed'

export interface PullRequestSetMember {
  readonly entryId: string
  readonly repository: string
  /** 1-based place in the skill-declared integration order (FR-117). */
  readonly position: number
  readonly outcome: PullRequestSetOutcome
  readonly pullRequest?: PullRequestRef
  /** The commit the forge was verified to hold. Absent unless one was opened. */
  readonly verifiedSha?: string
  /** True when the pull request was already open and this run created nothing. */
  readonly alreadyExisted?: boolean
  /** Why it failed, in the failing step's own words. Present only on `failed`. */
  readonly reason?: string
}

export interface PullRequestSet {
  /** Shared by every member, derived from the primary entry's skill (FR-116). */
  readonly branchName: string
  /** Every entry, in the skill-declared integration order. */
  readonly members: readonly PullRequestSetMember[]
  /** The entries that did not produce a pull request they were meant to. */
  readonly failed: readonly PullRequestSetMember[]
  /**
   * Changes landed for some entries and failed for others (FR-118).
   *
   * The caller must not report plain success while this is true. It is not the
   * same as "something failed": a set where *everything* failed is a failure,
   * not a partial result, and the two need different words in the outcome.
   */
  readonly isPartial: boolean
}

export interface OpenPullRequestSetInput {
  readonly workflowId: string
  /**
   * From the **primary** entry's `sisyphus-dev` skill. `branchName` is the
   * shared branch and `pullRequestTitle` the shared title (FR-110, FR-116).
   */
  readonly conventions: DeliveryConventions
  readonly entries: readonly PullRequestSetEntry[]
  /**
   * What the primary entry's `sisyphus-integration` skill declared (FR-117).
   * Omitted is only valid for a single-entry workspace; see `./promotion-order.ts`.
   */
  readonly promotionOrder?: Partial<DeclaredPromotionOrder>
  readonly summary: ReviewerSummary
  readonly readyForReview?: boolean
  /**
   * The run's ledger. Supply one to make a retry of the whole set replay what
   * it already opened without asking the forge again.
   */
  readonly ledger?: ExternalActionLedger<PullRequestDelivery>
}

/** A branch proposed onto itself, per repository. The FR-058 self-contradiction. */
export const selfProposedBranchError = (entryId: string, branch: string): Error =>
  new Error(
    `entry ${entryId} would propose ${branch} onto itself: the shared work branch and this ` +
      "repository's base branch are the same name. No pull request was opened.",
  )

const describe = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure)

/**
 * The cross-reference every member carries (FR-116).
 *
 * Composed once, before anything is created, and identical on all of them —
 * which is what makes it usable from *any* one of the set rather than only from
 * whichever was opened last.
 *
 * @param branchName - The shared branch, and the handle that joins the set.
 * @param ordered - Every entry in the skill-declared integration order.
 */
export const crossReference = (
  branchName: string,
  ordered: readonly { readonly entry: PullRequestSetEntry; readonly position: number }[],
): string => {
  const lines = ordered.map(({ entry, position }) => `${String(position)}. ${entry.repository}`)

  return [
    `This is one of ${String(ordered.length)} coordinated changes on the branch \`${branchName}\`.`,
    '',
    'Integration order, as the primary repository’s sisyphus-integration skill defines it:',
    ...lines,
  ].join('\n')
}

/**
 * Open one draft pull request per changed entry, all on one branch.
 *
 * @param input - The run, the primary entry's conventions, and every entry.
 * @returns Every entry's outcome, and whether the result is partial.
 * @throws Only when the set cannot be attempted at all — an integration order
 *   the skill did not state (FR-117). A failure *within* an entry is recorded
 *   against that entry, not thrown.
 */
export const openPullRequestSet = async (
  input: OpenPullRequestSetInput,
): Promise<PullRequestSet> => {
  const branchName = input.conventions.branchName
  const ordered = requirePromotionOrder(input.promotionOrder, {
    entries: input.entries,
    step: PULL_REQUEST_SET_STEP,
  })

  const reference = crossReference(branchName, ordered)
  const ledger = input.ledger ?? createExternalActionLedger<PullRequestDelivery>()
  const members: PullRequestSetMember[] = []

  for (const { entry, position } of ordered) {
    const identity = { entryId: entry.entryId, repository: entry.repository, position }

    if (!entry.wasChanged) {
      members.push({ ...identity, outcome: 'unchanged' })
      continue
    }

    // Per repository, because each states its own base: the shared branch may
    // legitimately be one repository's base branch and not another's.
    if (branchName === entry.baseBranch) {
      members.push({
        ...identity,
        outcome: 'failed',
        reason: selfProposedBranchError(entry.entryId, branchName).message,
      })
      continue
    }

    const conventions: DeliveryConventions = {
      ...input.conventions,
      baseBranch: entry.baseBranch,
      bodyPreamble:
        input.conventions.bodyPreamble === undefined
          ? reference
          : `${reference}\n\n${input.conventions.bodyPreamble.trim()}`,
    }

    try {
      const outcome = await performExternalAction(ledger, {
        identity: pullRequestIdentity({
          workflowId: input.workflowId,
          repository: entry.repository,
          head: branchName,
          base: entry.baseBranch,
        }),
        perform: () =>
          openDraftPullRequest({
            workflowId: input.workflowId,
            repository: entry.repository,
            conventions,
            ...(entry.preExecutionRemoteSha === undefined
              ? {}
              : { preExecutionRemoteSha: entry.preExecutionRemoteSha }),
            summary: input.summary,
            ...(input.readyForReview === undefined ? {} : { readyForReview: input.readyForReview }),
            git: entry.git,
            forge: entry.forge,
          }),
      })

      members.push({
        ...identity,
        outcome: 'opened',
        pullRequest: outcome.result.pullRequest,
        verifiedSha: outcome.result.verifiedSha,
        alreadyExisted: outcome.result.alreadyExisted || outcome.disposition !== 'performed',
      })
    } catch (failure) {
      // Recorded and carried on. The entries after this one still have to reach
      // a result of their own, and the whole set's partial state is the thing
      // FR-118 makes the workflow state rather than hide.
      members.push({ ...identity, outcome: 'failed', reason: describe(failure) })
    }
  }

  const failed = members.filter((member) => member.outcome === 'failed')

  return {
    branchName,
    members,
    failed,
    isPartial: failed.length > 0 && members.some((member) => member.outcome === 'opened'),
  }
}
