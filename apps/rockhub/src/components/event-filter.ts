// Event_Filter — pure event-to-mention transform encoding the seven
// Trigger_Source rules from the design document.
//
// `createEventFilter(config, logger)` returns a function that takes a
// `RawWebhookEvent` and returns either a `TriggerMention` (when the
// event matches one of the seven rules) or `null` (when it does not).
//
// Always-applied bot-self filter: if the actor or comment author login
// (case-insensitively) equals `BOT_USERNAME`, the filter returns `null`
// to prevent the bot from reacting to its own activity (Req 2.8).

import type { Logger } from 'pino'

import { composeIdentity, matchesBotMention } from '../lib/mention-identity'
import type { RawWebhookEvent, SourceType, TriggerMention } from '../lib/types'

// ── Public interface ───────────────────────────────────────────────

export interface EventFilterConfig {
  botUsername: string
}

export type EventFilterFn = (event: RawWebhookEvent) => TriggerMention | null

// ── Factory ────────────────────────────────────────────────────────

export const createEventFilter = (config: EventFilterConfig, logger: Logger): EventFilterFn => {
  const botUsername = config.botUsername

  return (event: RawWebhookEvent): TriggerMention | null => {
    switch (event.name) {
      // ── issues.opened / issues.edited / issues.reopened ──────────
      case 'issues.opened':
      case 'issues.edited':
      case 'issues.reopened': {
        const { payload } = event

        // Bot-self filter: actor is the sender
        if (isBotSelf(payload.sender.login, botUsername)) {
          logger.debug(
            { event: event.name, actor: payload.sender.login },
            'event skipped — actor is bot',
          )
          return null
        }

        const body = payload.issue.body ?? ''
        if (!matchesBotMention(body, botUsername)) {
          logger.debug(
            { event: event.name, issue: payload.issue.number },
            'event skipped — no bot mention in issue body',
          )
          return null
        }

        return buildTriggerMention({
          repoFullName: payload.repository.full_name,
          sourceType: 'issue_body',
          sourceId: String(payload.issue.number),
          issueOrPrNumber: payload.issue.number,
        })
      }

      // ── issues.assigned ─────────────────────────────────────────
      case 'issues.assigned': {
        const { payload } = event

        // Bot-self filter: actor is the sender
        if (isBotSelf(payload.sender.login, botUsername)) {
          logger.debug(
            { event: event.name, actor: payload.sender.login },
            'event skipped — actor is bot',
          )
          return null
        }

        if (!isBotSelf(payload.assignee.login, botUsername)) {
          logger.debug(
            { event: event.name, assignee: payload.assignee.login },
            'event skipped — assignee is not bot',
          )
          return null
        }

        return buildTriggerMention({
          repoFullName: payload.repository.full_name,
          sourceType: 'issue_assignment',
          sourceId: String(payload.issue.number),
          issueOrPrNumber: payload.issue.number,
        })
      }

      // ── issue_comment.created / issue_comment.edited ────────────
      case 'issue_comment.created':
      case 'issue_comment.edited': {
        const { payload } = event

        // Bot-self filter: comment author
        if (isBotSelf(payload.comment.user.login, botUsername)) {
          logger.debug(
            { event: event.name, author: payload.comment.user.login },
            'event skipped — comment author is bot',
          )
          return null
        }

        if (!matchesBotMention(payload.comment.body, botUsername)) {
          logger.debug(
            { event: event.name, commentId: payload.comment.id },
            'event skipped — no bot mention in comment body',
          )
          return null
        }

        // Distinguish issue comment vs PR comment based on pull_request field
        const isPr = payload.issue.pull_request != null
        const sourceType: SourceType = isPr ? 'pr_comment' : 'issue_comment'

        return buildTriggerMention({
          repoFullName: payload.repository.full_name,
          sourceType,
          sourceId: String(payload.comment.id),
          commentId: payload.comment.id,
          issueOrPrNumber: payload.issue.number,
        })
      }

      // ── pull_request.opened / pull_request.edited / pull_request.reopened
      case 'pull_request.opened':
      case 'pull_request.edited':
      case 'pull_request.reopened': {
        const { payload } = event

        // Bot-self filter: actor is the sender
        if (isBotSelf(payload.sender.login, botUsername)) {
          logger.debug(
            { event: event.name, actor: payload.sender.login },
            'event skipped — actor is bot',
          )
          return null
        }

        const body = payload.pull_request.body ?? ''
        if (!matchesBotMention(body, botUsername)) {
          logger.debug(
            { event: event.name, pr: payload.pull_request.number },
            'event skipped — no bot mention in PR body',
          )
          return null
        }

        return buildTriggerMention({
          repoFullName: payload.repository.full_name,
          sourceType: 'pr_body',
          sourceId: String(payload.pull_request.number),
          issueOrPrNumber: payload.pull_request.number,
        })
      }

      // ── pull_request.review_requested ───────────────────────────
      case 'pull_request.review_requested': {
        const { payload } = event

        // Bot-self filter: actor is the sender
        if (isBotSelf(payload.sender.login, botUsername)) {
          logger.debug(
            { event: event.name, actor: payload.sender.login },
            'event skipped — actor is bot',
          )
          return null
        }

        if (!isBotSelf(payload.requested_reviewer.login, botUsername)) {
          logger.debug(
            { event: event.name, reviewer: payload.requested_reviewer.login },
            'event skipped — requested reviewer is not bot',
          )
          return null
        }

        const prNumber = payload.pull_request.number
        const reviewerUserId = payload.requested_reviewer.id

        return buildTriggerMention({
          repoFullName: payload.repository.full_name,
          sourceType: 'pr_review_request',
          sourceId: `${String(prNumber)}:${String(reviewerUserId)}`,
          issueOrPrNumber: prNumber,
        })
      }

      // ── pull_request_review_comment.created / .edited ───────────
      case 'pull_request_review_comment.created':
      case 'pull_request_review_comment.edited': {
        const { payload } = event

        // Bot-self filter: comment author
        if (isBotSelf(payload.comment.user.login, botUsername)) {
          logger.debug(
            { event: event.name, author: payload.comment.user.login },
            'event skipped — comment author is bot',
          )
          return null
        }

        if (!matchesBotMention(payload.comment.body, botUsername)) {
          logger.debug(
            { event: event.name, commentId: payload.comment.id },
            'event skipped — no bot mention in review comment body',
          )
          return null
        }

        return buildTriggerMention({
          repoFullName: payload.repository.full_name,
          sourceType: 'pr_review_comment',
          sourceId: String(payload.comment.id),
          commentId: payload.comment.id,
          issueOrPrNumber: payload.pull_request.number,
        })
      }

      default: {
        // Exhaustive check — TypeScript will error if a case is missed
        const _exhaustive: never = event
        return _exhaustive
      }
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Case-insensitive comparison of a login against the bot username.
 * Used for both the bot-self filter and the assignment/review-request
 * matching.
 */
const isBotSelf = (login: string, botUsername: string): boolean =>
  login.toLowerCase() === botUsername.toLowerCase()

/**
 * Build a `TriggerMention` from the derived source-type fields.
 */
const buildTriggerMention = (params: {
  repoFullName: string
  sourceType: SourceType
  sourceId: string
  commentId?: number
  issueOrPrNumber?: number
}): TriggerMention => {
  const { repoFullName, sourceType, sourceId, commentId, issueOrPrNumber } = params
  const [owner, repo] = repoFullName.split('/')
  const identity = composeIdentity({ repoFullName, sourceType, sourceId })

  return {
    identity,
    repoFullName,
    sourceType,
    sourceId,
    owner,
    repo,
    ...(commentId != null && { commentId }),
    ...(issueOrPrNumber != null && { issueOrPrNumber }),
  }
}
