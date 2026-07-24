/**
 * Webhook receiver for GitHub webhook events.
 *
 * Uses `@octokit/webhooks` to validate HMAC-SHA256 signatures and
 * dispatch events through the processing pipeline:
 *   Event_Filter → Repo_Filter → Mention_Queue
 *
 * Registered event handlers (12 event types):
 * - `issues.opened`, `issues.edited`, `issues.reopened`, `issues.assigned`
 * - `issue_comment.created`, `issue_comment.edited`
 * - `pull_request.opened`, `pull_request.edited`, `pull_request.reopened`,
 *   `pull_request.review_requested`
 * - `pull_request_review_comment.created`, `pull_request_review_comment.edited`
 *
 * Returns 200 immediately after the synchronous `offer` call. The Octokit
 * library handles 401 responses for invalid signatures automatically.
 */

import { Webhooks, createNodeMiddleware } from '@octokit/webhooks'
import type pino from 'pino'

import type {
  IssueAssignedPayload,
  IssueCommentPayload,
  IssuePayload,
  PRPayload,
  PRReviewCommentPayload,
  PRReviewRequestedPayload,
  RawWebhookEvent,
  TriggerMention,
  WebhookPayload,
} from '../lib'

import type { MentionQueueInstance, QueuedMention } from './mention-queue'

// ── Public Interfaces ──────────────────────────────────────────────

export interface WebhookReceiverConfig {
  webhookPath: string
  webhookSecret: string
}

export interface WebhookReceiverDeps {
  eventFilter: (raw: RawWebhookEvent) => TriggerMention | null
  repoFilter: (repoFullName: string) => boolean
  mentionQueue: MentionQueueInstance
  logger: pino.Logger
}

export interface WebhookReceiverResult {
  webhooks: Webhooks
  middleware: ReturnType<typeof createNodeMiddleware>
}

// ── Factory ────────────────────────────────────────────────────────

export const createWebhookReceiver = (
  config: WebhookReceiverConfig,
  deps: WebhookReceiverDeps,
): WebhookReceiverResult => {
  const { eventFilter, repoFilter, mentionQueue, logger } = deps
  const log = logger.child({ component: 'webhook-receiver' })

  const webhooks = new Webhooks({ secret: config.webhookSecret })

  // ── Helper: run the filter → repo-filter → offer pipeline ──────

  const processEvent = (
    rawEvent: RawWebhookEvent,
    payload: WebhookPayload,
    deliveryId: string,
  ): void => {
    const mention = eventFilter(rawEvent)

    if (mention == null) {
      log.debug(
        { event: rawEvent.name, deliveryId },
        'Webhook event dropped — event filter returned null',
      )
      return
    }

    if (!repoFilter(mention.repoFullName)) {
      log.debug(
        { event: rawEvent.name, repo: mention.repoFullName, deliveryId },
        'Webhook event dropped — repo filter rejected',
      )
      return
    }

    const item: QueuedMention = {
      mention,
      payload,
      eventName: rawEvent.name,
      deliveryId,
    }

    const accepted = mentionQueue.offer(item)

    if (accepted) {
      log.info(
        {
          event: rawEvent.name,
          mentionIdentity: mention.identity,
          repo: mention.repoFullName,
          sourceType: mention.sourceType,
          deliveryId,
        },
        'Webhook event enqueued',
      )
    } else {
      log.debug(
        {
          event: rawEvent.name,
          mentionIdentity: mention.identity,
          repo: mention.repoFullName,
          sourceType: mention.sourceType,
          deliveryId,
        },
        'Webhook event dropped — duplicate identity',
      )
    }
  }

  // ── issues.opened ──────────────────────────────────────────────

  webhooks.on('issues.opened', ({ id, payload }) => {
    log.info({ event: 'issues.opened', deliveryId: id }, 'Webhook received')
    processEvent(
      { name: 'issues.opened', payload: payload as unknown as IssuePayload },
      payload as unknown as WebhookPayload,
      id,
    )
  })

  // ── issues.edited ──────────────────────────────────────────────

  webhooks.on('issues.edited', ({ id, payload }) => {
    log.info({ event: 'issues.edited', deliveryId: id }, 'Webhook received')
    processEvent(
      { name: 'issues.edited', payload: payload as unknown as IssuePayload },
      payload as unknown as WebhookPayload,
      id,
    )
  })

  // ── issues.reopened ────────────────────────────────────────────

  webhooks.on('issues.reopened', ({ id, payload }) => {
    log.info({ event: 'issues.reopened', deliveryId: id }, 'Webhook received')
    processEvent(
      { name: 'issues.reopened', payload: payload as unknown as IssuePayload },
      payload as unknown as WebhookPayload,
      id,
    )
  })

  // ── issues.assigned ────────────────────────────────────────────

  webhooks.on('issues.assigned', ({ id, payload }) => {
    log.info({ event: 'issues.assigned', deliveryId: id }, 'Webhook received')
    processEvent(
      { name: 'issues.assigned', payload: payload as unknown as IssueAssignedPayload },
      payload as unknown as WebhookPayload,
      id,
    )
  })

  // ── issue_comment.created ──────────────────────────────────────

  webhooks.on('issue_comment.created', ({ id, payload }) => {
    log.info({ event: 'issue_comment.created', deliveryId: id }, 'Webhook received')
    processEvent(
      { name: 'issue_comment.created', payload: payload as unknown as IssueCommentPayload },
      payload as unknown as WebhookPayload,
      id,
    )
  })

  // ── issue_comment.edited ───────────────────────────────────────

  webhooks.on('issue_comment.edited', ({ id, payload }) => {
    log.info({ event: 'issue_comment.edited', deliveryId: id }, 'Webhook received')
    processEvent(
      { name: 'issue_comment.edited', payload: payload as unknown as IssueCommentPayload },
      payload as unknown as WebhookPayload,
      id,
    )
  })

  // ── pull_request.opened ────────────────────────────────────────

  webhooks.on('pull_request.opened', ({ id, payload }) => {
    log.info({ event: 'pull_request.opened', deliveryId: id }, 'Webhook received')
    processEvent(
      { name: 'pull_request.opened', payload: payload as unknown as PRPayload },
      payload as unknown as WebhookPayload,
      id,
    )
  })

  // ── pull_request.edited ────────────────────────────────────────

  webhooks.on('pull_request.edited', ({ id, payload }) => {
    log.info({ event: 'pull_request.edited', deliveryId: id }, 'Webhook received')
    processEvent(
      { name: 'pull_request.edited', payload: payload as unknown as PRPayload },
      payload as unknown as WebhookPayload,
      id,
    )
  })

  // ── pull_request.reopened ──────────────────────────────────────

  webhooks.on('pull_request.reopened', ({ id, payload }) => {
    log.info({ event: 'pull_request.reopened', deliveryId: id }, 'Webhook received')
    processEvent(
      { name: 'pull_request.reopened', payload: payload as unknown as PRPayload },
      payload as unknown as WebhookPayload,
      id,
    )
  })

  // ── pull_request.review_requested ──────────────────────────────

  webhooks.on('pull_request.review_requested', ({ id, payload }) => {
    log.info({ event: 'pull_request.review_requested', deliveryId: id }, 'Webhook received')
    processEvent(
      {
        name: 'pull_request.review_requested',
        payload: payload as unknown as PRReviewRequestedPayload,
      },
      payload as unknown as WebhookPayload,
      id,
    )
  })

  // ── pull_request_review_comment.created ────────────────────────

  webhooks.on('pull_request_review_comment.created', ({ id, payload }) => {
    log.info({ event: 'pull_request_review_comment.created', deliveryId: id }, 'Webhook received')
    processEvent(
      {
        name: 'pull_request_review_comment.created',
        payload: payload as unknown as PRReviewCommentPayload,
      },
      payload as unknown as WebhookPayload,
      id,
    )
  })

  // ── pull_request_review_comment.edited ─────────────────────────

  webhooks.on('pull_request_review_comment.edited', ({ id, payload }) => {
    log.info({ event: 'pull_request_review_comment.edited', deliveryId: id }, 'Webhook received')
    processEvent(
      {
        name: 'pull_request_review_comment.edited',
        payload: payload as unknown as PRReviewCommentPayload,
      },
      payload as unknown as WebhookPayload,
      id,
    )
  })

  // ── ping ───────────────────────────────────────────────────────

  webhooks.on('ping', ({ payload }) => {
    log.info(
      { hookId: payload.hook_id, zen: payload.zen },
      'Received ping event — webhook is connected',
    )
  })

  // ── Error handler ──────────────────────────────────────────────

  webhooks.onError((error) => {
    log.error({ err: error }, 'Webhook handler error')
  })

  // ── Middleware ─────────────────────────────────────────────────

  const middleware = createNodeMiddleware(webhooks, {
    path: config.webhookPath,
  })

  return { webhooks, middleware }
}
