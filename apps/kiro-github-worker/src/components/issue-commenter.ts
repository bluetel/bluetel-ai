/**
 * Issue commenter for posting status comments on GitHub issues and PRs.
 *
 * Posts formatted status messages using the shared comment templates.
 * All comments include the `<!-- rocky-worker -->` marker for loop
 * prevention and are prefixed with the Rocky bot display name.
 */

import type { Octokit } from '@octokit/rest'

import { COMMENT_MARKER, TEMPLATES } from '../lib/types.js'

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Splits a repository full name (e.g. `owner/repo`) into its owner and
 * repo components for use with the Octokit API.
 */
const splitRepo = (repoFullName: string): { owner: string; repo: string } => {
  const slashIdx = repoFullName.indexOf('/')
  return {
    owner: repoFullName.slice(0, slashIdx),
    repo: repoFullName.slice(slashIdx + 1),
  }
}

/**
 * Posts a comment on a GitHub issue or pull request.
 */
const createComment = async (
  octokit: Octokit,
  repoFullName: string,
  issueNumber: number,
  body: string,
): Promise<void> => {
  const { owner, repo } = splitRepo(repoFullName)
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  })
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Posts a success comment with the PR link on the originating issue.
 *
 * @param octokit - Authenticated Octokit instance
 * @param repo - Repository full name (e.g. `owner/repo`)
 * @param issueNumber - Issue number to comment on
 * @param prUrl - URL of the created pull request
 */
export const postSuccess = async (
  octokit: Octokit,
  repo: string,
  issueNumber: number,
  prUrl: string,
): Promise<void> => {
  const body = TEMPLATES.success.replace('{prUrl}', prUrl)
  await createComment(octokit, repo, issueNumber, body)
}

/**
 * Posts an update confirmation comment with the latest commit SHA.
 *
 * @param octokit - Authenticated Octokit instance
 * @param repo - Repository full name (e.g. `owner/repo`)
 * @param issueNumber - Issue number to comment on
 * @param commitSha - SHA of the latest commit pushed
 */
export const postUpdated = async (
  octokit: Octokit,
  repo: string,
  issueNumber: number,
  commitSha: string,
): Promise<void> => {
  const body = TEMPLATES.updated.replace('{commitSha}', commitSha)
  await createComment(octokit, repo, issueNumber, body)
}

/**
 * Posts an error comment describing which step failed and the error details.
 *
 * @param octokit - Authenticated Octokit instance
 * @param repo - Repository full name (e.g. `owner/repo`)
 * @param issueNumber - Issue number to comment on
 * @param step - The processing step that failed (e.g. `clone`, `kiro-cli`)
 * @param error - Error message or description
 */
export const postError = async (
  octokit: Octokit,
  repo: string,
  issueNumber: number,
  step: string,
  error: string,
): Promise<void> => {
  const body = TEMPLATES.error.replace('{step}', step).replace('{error}', error)
  await createComment(octokit, repo, issueNumber, body)
}

/**
 * Posts a queued status comment indicating the request position in the queue.
 *
 * @param octokit - Authenticated Octokit instance
 * @param repo - Repository full name (e.g. `owner/repo`)
 * @param issueNumber - Issue number to comment on
 * @param position - Position in the queue (1-based)
 */
export const postQueued = async (
  octokit: Octokit,
  repo: string,
  issueNumber: number,
  position: number,
): Promise<void> => {
  const body = TEMPLATES.queued.replace('{position}', String(position))
  await createComment(octokit, repo, issueNumber, body)
}

/**
 * Posts a merge conflict notice on the issue.
 *
 * @param octokit - Authenticated Octokit instance
 * @param repo - Repository full name (e.g. `owner/repo`)
 * @param issueNumber - Issue number to comment on
 */
export const postConflict = async (
  octokit: Octokit,
  repo: string,
  issueNumber: number,
): Promise<void> => {
  await createComment(octokit, repo, issueNumber, TEMPLATES.conflict)
}

/**
 * Posts a PR feedback acknowledgment comment with the commit SHA.
 *
 * @param octokit - Authenticated Octokit instance
 * @param repo - Repository full name (e.g. `owner/repo`)
 * @param prNumber - Pull request number to comment on
 * @param commitSha - SHA of the commit addressing the feedback
 */
export const postPRFeedbackAck = async (
  octokit: Octokit,
  repo: string,
  prNumber: number,
  commitSha: string,
): Promise<void> => {
  const body = TEMPLATES.prFeedbackAck.replace('{commitSha}', commitSha)
  await createComment(octokit, repo, prNumber, body)
}

/**
 * Posts a PR feedback error comment describing the failure.
 *
 * @param octokit - Authenticated Octokit instance
 * @param repo - Repository full name (e.g. `owner/repo`)
 * @param prNumber - Pull request number to comment on
 * @param error - Error message or description
 */
export const postPRFeedbackError = async (
  octokit: Octokit,
  repo: string,
  prNumber: number,
  error: string,
): Promise<void> => {
  const body = TEMPLATES.prFeedbackError.replace('{error}', error)
  await createComment(octokit, repo, prNumber, body)
}

/**
 * Re-export the comment marker for convenience.
 */
export { COMMENT_MARKER }

/**
 * Adds an 👀 (eyes) reaction to a comment to acknowledge receipt.
 *
 * @param octokit - Authenticated Octokit instance
 * @param repo - Repository full name (e.g. `owner/repo`)
 * @param commentId - The comment ID to react to
 */
export const addEyesReaction = async (
  octokit: Octokit,
  repo: string,
  commentId: number,
): Promise<void> => {
  const { owner, repo: repoName } = splitRepo(repo)
  await octokit.reactions.createForIssueComment({
    owner,
    repo: repoName,
    comment_id: commentId,
    content: 'eyes',
  })
}
