/**
 * In-memory store for human-in-the-loop review requests.
 *
 * Tracks review lifecycle: creation, the human approve/reject decision,
 * and auto-expiry of stale pending reviews. Reviews are held in memory for
 * the lifetime of the Worker process, mirroring the MCP task store.
 */

import type pino from 'pino'

import {
  type DecideOutcome,
  type Review,
  type ReviewDecision,
  type ReviewInput,
  type ReviewStore,
} from '../lib/review-types'

// ── Helpers ─────────────────────────────────────────────────────────

/** Strips ANSI escape sequences from a string. */
const stripAnsi = (str: string): string =>
  // eslint-disable-next-line no-control-regex
  str.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)/g, '')

const TERMINAL = new Set<Review['status']>(['approved', 'rejected', 'expired'])

// ── Implementation ──────────────────────────────────────────────────

/**
 * Creates a ReviewStore backed by an in-memory Map.
 *
 * @param logger - Pino logger instance
 */
export const createReviewStore = (logger: pino.Logger): ReviewStore => {
  const reviews = new Map<string, Review>()

  const create = (input: ReviewInput): Review => {
    const id = crypto.randomUUID()
    const now = new Date()
    const expiresAt =
      input.ttlSeconds != null && input.ttlSeconds > 0
        ? new Date(now.getTime() + input.ttlSeconds * 1000)
        : null

    const review: Review = {
      id,
      status: 'pending',
      title: stripAnsi(input.title),
      content: stripAnsi(input.content),
      context: input.context != null ? stripAnsi(input.context) : null,
      repoFullName: input.repoFullName ?? null,
      branch: input.branch ?? null,
      iteration: input.iteration ?? null,
      metadata: input.metadata ?? {},
      decision: null,
      comment: '',
      reviewer: '',
      createdAt: now,
      updatedAt: now,
      decidedAt: null,
      expiresAt,
    }

    reviews.set(id, review)
    logger.info({ reviewId: id, title: review.title }, 'Review created')

    return review
  }

  const get = (id: string): Review | undefined => reviews.get(id)

  const getAll = (): Review[] => [...reviews.values()]

  const decide = (
    id: string,
    decision: ReviewDecision,
    comment: string,
    reviewer: string,
  ): DecideOutcome => {
    const review = reviews.get(id)
    if (review == null) return { kind: 'not-found' }

    if (TERMINAL.has(review.status)) {
      return { kind: 'conflict', review }
    }

    const now = new Date()
    review.status = decision
    review.decision = decision
    review.comment = stripAnsi(comment)
    review.reviewer = reviewer
    review.updatedAt = now
    review.decidedAt = now

    logger.info({ reviewId: id, decision, reviewer }, 'Review decided')

    return { kind: 'ok', review }
  }

  const expireOverdue = (now: Date = new Date()): number => {
    let expired = 0
    for (const review of reviews.values()) {
      if (
        review.status === 'pending' &&
        review.expiresAt != null &&
        review.expiresAt.getTime() <= now.getTime()
      ) {
        review.status = 'expired'
        review.updatedAt = now
        expired++
        logger.info({ reviewId: review.id }, 'Review expired')
      }
    }
    return expired
  }

  return { create, get, getAll, decide, expireOverdue }
}
