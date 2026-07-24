/**
 * Event filter for webhook payloads.
 *
 * Inspects incoming webhook payloads and determines whether they should
 * be processed based on event type, labels, and bot mentions.
 *
 * Supported events:
 * - `issues.labeled` → trigger label match
 * - `issue_comment.created` on issue → trigger label + bot mention
 * - `issue_comment.created` on PR → bot mention (any PR)
 * - `pull_request_review_comment.created` → bot mention (any PR)
 * - `pull_request_review.submitted` (changes_requested) → any PR (no mention required)
 *
 * Rejects comments authored by the bot itself to prevent infinite loops.
 */

import type pino from 'pino'

import type {
  FilteredEvent,
  IssueCommentPayload,
  IssueEventPayload,
  PRReviewCommentPayload,
  PRReviewPayload,
} from '../lib/types.js'
import { COMMENT_MARKER } from '../lib/types.js'

import type { BranchMapInstance } from './branch-map.js'

// ── Types ───────────────────────────────────────────────────────────

export interface EventFilterConfig {
  triggerLabels: string[]
  botUsername: string
}

/**
 * Discriminated webhook event passed into the filter.
 * The caller (webhook receiver) determines the event name from the
 * `X-GitHub-Event` header + payload `action` field.
 */
export type WebhookEvent =
  | { name: 'issues.labeled'; payload: IssueEventPayload }
  | { name: 'issue_comment.created'; payload: IssueCommentPayload }
  | { name: 'pull_request_review_comment.created'; payload: PRReviewCommentPayload }
  | { name: 'pull_request_review.submitted'; payload: PRReviewPayload }

// ── Implementation ──────────────────────────────────────────────────

/**
 * Creates an event filter function bound to the given config, branch map,
 * and logger.
 *
 * @param config - Trigger labels and bot username configuration
 * @param branchMap - Branch map instance for PR ownership checks
 * @param logger - Pino logger instance for debug-level skip logging
 * @returns A function that returns a typed `FilteredEvent` or `null` for non-matching events
 */
export const createEventFilter = (
  config: EventFilterConfig,
  branchMap: BranchMapInstance,
  logger: pino.Logger,
): ((event: WebhookEvent) => FilteredEvent | null) => {
  const log = logger.child({ component: 'event-filter' })

  /**
   * Checks whether a comment body contains a bot mention (`@{botUsername}`).
   */
  const hasBotMention = (body: string): boolean => body.includes(`@${config.botUsername}`)

  /**
   * Checks whether a comment was authored by the bot itself.
   * Uses both the HTML marker and the author username as checks.
   */
  const isBotComment = (body: string, authorLogin: string): boolean => {
    if (authorLogin === config.botUsername) return true
    if (body.includes(COMMENT_MARKER)) return true
    return false
  }

  /**
   * Resolves the issue number associated with a PR from the branch map.
   */
  const resolveIssueNumber = (repoFullName: string, branchRef: string): number | null => {
    const issueNumber = branchMap.findByBranch(repoFullName, branchRef)
    return issueNumber ?? null
  }

  /**
   * Main filter function. Returns a typed FilteredEvent or null.
   */
  const filterEvent = (event: WebhookEvent): FilteredEvent | null => {
    switch (event.name) {
      case 'issues.labeled':
        return handleIssueLabeled(event.payload)
      case 'issue_comment.created':
        return handleIssueComment(event.payload)
      case 'pull_request_review_comment.created':
        return handlePRReviewComment(event.payload)
      case 'pull_request_review.submitted':
        return handlePRReview(event.payload)
      default:
        return null
    }
  }

  /**
   * Handle `issues.labeled`: check if the added label is in trigger labels.
   */
  const handleIssueLabeled = (payload: IssueEventPayload): FilteredEvent | null => {
    const repo = payload.repository.full_name
    const labelName = payload.label.name

    if (!config.triggerLabels.includes(labelName)) {
      log.debug({ repo, label: labelName }, 'Label does not match trigger labels, skipping')
      return null
    }

    return {
      type: 'new_issue',
      repo,
      issueNumber: payload.issue.number,
      issueTitle: payload.issue.title,
      issueBody: payload.issue.body ?? '',
    }
  }

  /**
   * Handle `issue_comment.created`:
   * - On a regular issue: check trigger label + bot mention
   * - On a PR (issue with pull_request field): check Worker-created PR + bot mention
   */
  const handleIssueComment = (payload: IssueCommentPayload): FilteredEvent | null => {
    const repo = payload.repository.full_name
    const commentBody = payload.comment.body
    const authorLogin = payload.comment.user.login

    // Reject bot's own comments
    if (isBotComment(commentBody, authorLogin)) {
      log.debug({ repo, author: authorLogin }, 'Ignoring bot own comment, skipping')
      return null
    }

    // Check if this is a comment on a PR
    if (payload.issue.pull_request != null) {
      return handlePRIssueComment(payload)
    }

    // Regular issue comment: check trigger label + bot mention
    const hasLabel = payload.issue.labels.some((l) => config.triggerLabels.includes(l.name))
    if (!hasLabel) {
      log.debug(
        { repo, issueNumber: payload.issue.number },
        'Issue does not have trigger label, skipping',
      )
      return null
    }

    if (!hasBotMention(commentBody)) {
      log.debug(
        {
          repo,
          issueNumber: payload.issue.number,
          ...(process.env['NODE_ENV'] !== 'production' ? { commentBody } : {}),
        },
        'Comment does not mention bot, skipping',
      )
      return null
    }

    return {
      type: 'follow_up_comment',
      repo,
      issueNumber: payload.issue.number,
      issueTitle: payload.issue.title,
      issueBody: payload.issue.body ?? '',
      commentBody,
      commentId: payload.comment.id,
    }
  }

  /**
   * Handle `issue_comment.created` on a PR (GitHub delivers PR comments as issue comments).
   * Requires bot mention. Works on any PR, not just Worker-created ones.
   *
   * Note: The IssueCommentPayload for PR comments doesn't include the PR head ref
   * directly, so branchRef is set to null. The job processor fetches it from the API.
   */
  const handlePRIssueComment = (payload: IssueCommentPayload): FilteredEvent | null => {
    const repo = payload.repository.full_name
    const commentBody = payload.comment.body
    const prNumber = payload.issue.number

    if (!hasBotMention(commentBody)) {
      log.debug(
        {
          repo,
          prNumber,
          ...(process.env['NODE_ENV'] !== 'production' ? { commentBody } : {}),
        },
        'PR comment does not mention bot, skipping',
      )
      return null
    }

    // Try to resolve issue number from branch map if available
    const issueNumber = branchMap.findByPR(repo, prNumber)

    return {
      type: 'pr_comment',
      repo,
      prNumber,
      issueNumber: issueNumber ?? null,
      commentBody,
      commentId: payload.comment.id,
      branchRef: null, // Not available from issue_comment payload
    }
  }

  /**
   * Handle `pull_request_review_comment.created`:
   * Requires bot mention. Works on any PR.
   */
  const handlePRReviewComment = (payload: PRReviewCommentPayload): FilteredEvent | null => {
    const repo = payload.repository.full_name
    const commentBody = payload.comment.body
    const authorLogin = payload.comment.user.login
    const prNumber = payload.pull_request.number
    const branchRef = payload.pull_request.head.ref

    // Reject bot's own comments
    if (isBotComment(commentBody, authorLogin)) {
      log.debug({ repo, author: authorLogin }, 'Ignoring bot own review comment, skipping')
      return null
    }

    // Check bot mention
    if (!hasBotMention(commentBody)) {
      log.debug(
        {
          repo,
          prNumber,
          ...(process.env['NODE_ENV'] !== 'production' ? { commentBody } : {}),
        },
        'Review comment does not mention bot, skipping',
      )
      return null
    }

    const issueNumber = resolveIssueNumber(repo, branchRef)

    return {
      type: 'pr_review_comment',
      repo,
      prNumber,
      issueNumber,
      commentBody,
      commentId: payload.comment.id,
      filePath: payload.comment.path,
      lineContext: payload.comment.line != null ? `Line ${payload.comment.line}` : '',
      branchRef,
    }
  }

  /**
   * Handle `pull_request_review.submitted` with `changes_requested`:
   * Works on any PR. No bot mention required.
   */
  const handlePRReview = (payload: PRReviewPayload): FilteredEvent | null => {
    const repo = payload.repository.full_name
    const reviewState = payload.review.state
    const reviewAuthorLogin = payload.review.user.login
    const prNumber = payload.pull_request.number
    const branchRef = payload.pull_request.head.ref

    // Only process changes_requested reviews
    if (reviewState !== 'changes_requested') {
      log.debug({ repo, prNumber, reviewState }, 'Review is not changes_requested, skipping')
      return null
    }

    // Reject bot's own reviews
    if (reviewAuthorLogin === config.botUsername) {
      log.debug({ repo, author: reviewAuthorLogin }, 'Ignoring bot own review, skipping')
      return null
    }

    const issueNumber = resolveIssueNumber(repo, branchRef)

    return {
      type: 'pr_review_changes_requested',
      repo,
      prNumber,
      issueNumber,
      reviewBody: payload.review.body ?? '',
      reviewComments: [],
      branchRef,
    }
  }

  return filterEvent
}
