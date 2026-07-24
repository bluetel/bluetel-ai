/**
 * Webhook receiver for GitHub webhook events.
 *
 * Uses `@octokit/webhooks` to validate HMAC-SHA256 signatures and
 * dispatch events through the processing pipeline:
 *   Repo_Filter → Event_Filter → Job_Queue
 *
 * Registered event handlers:
 * - `issues.labeled`
 * - `issue_comment.created`
 * - `pull_request_review_comment.created`
 * - `pull_request_review.submitted`
 *
 * Returns 200 immediately after enqueuing. The Octokit library handles
 * 401 responses for invalid signatures automatically.
 */

import { Webhooks, createNodeMiddleware } from '@octokit/webhooks'
import type pino from 'pino'

import type { FilteredEvent } from '../lib/types.js'

import type { WebhookEvent } from './event-filter.js'
import type { JobQueueInstance } from './job-queue.js'

// ── Types ───────────────────────────────────────────────────────────

export interface WebhookReceiverConfig {
  webhookPath: string
  webhookSecret: string
}

export interface WebhookReceiverDeps {
  repoFilter: (repoFullName: string) => boolean
  eventFilter: (event: WebhookEvent) => FilteredEvent | null
  jobQueue: JobQueueInstance
  logger: pino.Logger
}

export interface WebhookReceiverResult {
  webhooks: Webhooks
  middleware: ReturnType<typeof createNodeMiddleware>
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Extracts label names from an Octokit labels array, handling the
 * mixed types (string | object | null) that the API can return.
 */
const extractLabels = (
  labels: Array<string | { name?: string } | null | undefined> | undefined,
): Array<{ name: string }> =>
  (labels ?? [])
    .map((l) => {
      if (l == null) return null
      if (typeof l === 'string') return { name: l }
      if (typeof l === 'object' && 'name' in l && typeof l.name === 'string')
        return { name: l.name }
      return null
    })
    .filter((l): l is { name: string } => l != null)

// ── Implementation ──────────────────────────────────────────────────

/**
 * Creates a webhook receiver with Octokit webhook middleware.
 *
 * @param config - Webhook path and secret configuration
 * @param deps - Dependencies: repo filter, event filter, job queue, and logger
 * @returns The Webhooks instance and an Express-compatible middleware function
 */
export const createWebhookReceiver = (
  config: WebhookReceiverConfig,
  deps: WebhookReceiverDeps,
): WebhookReceiverResult => {
  const { repoFilter, eventFilter, jobQueue, logger } = deps
  const log = logger.child({ component: 'webhook-receiver' })

  const webhooks = new Webhooks({ secret: config.webhookSecret })

  /**
   * Passes a filtered event to the job queue if non-null.
   */
  const enqueueIfMatched = (repo: string, filtered: FilteredEvent | null): void => {
    if (filtered != null) {
      jobQueue.enqueue(filtered)
      log.info({ repo, type: filtered.type }, 'Event enqueued')
    }
  }

  // ── issues.labeled ──────────────────────────────────────────────

  webhooks.on('issues.labeled', ({ payload }) => {
    const repo = payload.repository.full_name
    log.debug({ repo, action: 'labeled' }, 'Received issues.labeled event')

    if (!repoFilter(repo)) return

    const filtered = eventFilter({
      name: 'issues.labeled',
      payload: {
        action: 'labeled',
        repository: { full_name: repo },
        issue: {
          number: payload.issue.number,
          title: payload.issue.title,
          body: payload.issue.body ?? null,
          labels: extractLabels(payload.issue.labels as Array<string | { name?: string } | null>),
        },
        label: { name: payload.label?.name ?? '' },
      },
    })

    enqueueIfMatched(repo, filtered)
  })

  // ── issue_comment.created ───────────────────────────────────────

  webhooks.on('issue_comment.created', ({ payload }) => {
    const repo = payload.repository.full_name
    log.debug({ repo, action: 'created' }, 'Received issue_comment.created event')

    if (!repoFilter(repo)) return

    const commentUserLogin = payload.comment.user?.login ?? ''

    const filtered = eventFilter({
      name: 'issue_comment.created',
      payload: {
        action: 'created',
        repository: { full_name: repo },
        issue: {
          number: payload.issue.number,
          title: payload.issue.title,
          body: payload.issue.body ?? null,
          labels: extractLabels(payload.issue.labels as Array<string | { name?: string } | null>),
          pull_request:
            payload.issue.pull_request != null
              ? { url: payload.issue.pull_request.url ?? '' }
              : undefined,
        },
        comment: {
          id: payload.comment.id,
          body: payload.comment.body,
          user: { login: commentUserLogin },
        },
      },
    })

    enqueueIfMatched(repo, filtered)
  })

  // ── pull_request_review_comment.created ─────────────────────────

  webhooks.on('pull_request_review_comment.created', ({ payload }) => {
    const repo = payload.repository.full_name
    log.debug({ repo, action: 'created' }, 'Received pull_request_review_comment.created event')

    if (!repoFilter(repo)) return

    const prUserLogin = payload.pull_request.user?.login ?? ''
    const commentUserLogin = payload.comment.user?.login ?? ''

    const filtered = eventFilter({
      name: 'pull_request_review_comment.created',
      payload: {
        action: 'created',
        repository: { full_name: repo },
        pull_request: {
          number: payload.pull_request.number,
          head: { ref: payload.pull_request.head.ref },
          user: { login: prUserLogin },
        },
        comment: {
          id: payload.comment.id,
          body: payload.comment.body,
          path: payload.comment.path,
          line: payload.comment.line ?? null,
          user: { login: commentUserLogin },
        },
      },
    })

    enqueueIfMatched(repo, filtered)
  })

  // ── pull_request_review.submitted ───────────────────────────────

  webhooks.on('pull_request_review.submitted', ({ payload }) => {
    const repo = payload.repository.full_name
    log.debug({ repo, action: 'submitted' }, 'Received pull_request_review.submitted event')

    if (!repoFilter(repo)) return

    const prUserLogin = payload.pull_request.user?.login ?? ''
    const reviewUserLogin = payload.review.user?.login ?? ''

    const filtered = eventFilter({
      name: 'pull_request_review.submitted',
      payload: {
        action: 'submitted',
        repository: { full_name: repo },
        pull_request: {
          number: payload.pull_request.number,
          head: { ref: payload.pull_request.head.ref },
          user: { login: prUserLogin },
        },
        review: {
          state: payload.review.state as 'changes_requested' | 'approved' | 'commented',
          body: payload.review.body ?? null,
          user: { login: reviewUserLogin },
        },
      },
    })

    enqueueIfMatched(repo, filtered)
  })

  // ── ping ─────────────────────────────────────────────────────────

  webhooks.on('ping', ({ payload }) => {
    log.info(
      { hookId: payload.hook_id, zen: payload.zen },
      'Received ping event — webhook is connected',
    )
  })

  // ── Error handler ───────────────────────────────────────────────

  webhooks.onError((error) => {
    log.error({ err: error }, 'Webhook handler error')
  })

  // ── Middleware ───────────────────────────────────────────────────

  const middleware = createNodeMiddleware(webhooks, {
    path: config.webhookPath,
  })

  return { webhooks, middleware }
}
