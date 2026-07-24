/**
 * Admin API router for human-in-the-loop review requests.
 *
 * Exposes endpoints for creating reviews (called by the Dify `request_review`
 * tool), listing/viewing them in the dashboard, and recording the human
 * approve/reject decision. Mounted alongside the main admin router under
 * `/api`, so it inherits the same bearer-token authentication.
 */

import express, { Router } from 'express'
import type pino from 'pino'

import type { Review, ReviewStore } from '../lib/review-types'

// ── Types ───────────────────────────────────────────────────────────

export interface ReviewApiDependencies {
  reviewStore: ReviewStore
  logger: pino.Logger
}

/** Wire-format review (dates serialized to ISO 8601 strings). */
export interface SerializedReview {
  id: string
  status: Review['status']
  title: string
  content: string
  context: string | null
  repoFullName: string | null
  branch: string | null
  iteration: number | null
  metadata: Record<string, string>
  decision: Review['decision']
  comment: string
  reviewer: string
  createdAt: string
  updatedAt: string
  decidedAt: string | null
  expiresAt: string | null
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Serializes a stored review into its wire format. */
export const serializeReview = (review: Review): SerializedReview => ({
  id: review.id,
  status: review.status,
  title: review.title,
  content: review.content,
  context: review.context,
  repoFullName: review.repoFullName,
  branch: review.branch,
  iteration: review.iteration,
  metadata: review.metadata,
  decision: review.decision,
  comment: review.comment,
  reviewer: review.reviewer,
  createdAt: review.createdAt.toISOString(),
  updatedAt: review.updatedAt.toISOString(),
  decidedAt: review.decidedAt != null ? review.decidedAt.toISOString() : null,
  expiresAt: review.expiresAt != null ? review.expiresAt.toISOString() : null,
})

/** Coerces an unknown value to a trimmed string, or '' when absent. */
const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** Coerces an unknown value to a finite positive integer, or undefined. */
const asPositiveInt = (value: unknown): number | undefined => {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined
}

/** Coerces an unknown value to a flat string/string record, or undefined. */
const asStringRecord = (value: unknown): Record<string, string> | undefined => {
  if (value == null || typeof value !== 'object') return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = typeof v === 'string' ? v : String(v)
  }
  return out
}

/**
 * Orders reviews for the dashboard: pending first (oldest first, so the
 * longest-waiting review is actioned soonest), then resolved reviews newest
 * first.
 */
export const sortReviews = (reviews: SerializedReview[]): SerializedReview[] =>
  [...reviews].sort((a, b) => {
    const aPending = a.status === 'pending'
    const bPending = b.status === 'pending'
    if (aPending !== bPending) return aPending ? -1 : 1
    const order = aPending ? 1 : -1
    return order * (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime())
  })

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Creates an Express router with review API endpoints.
 */
export const createReviewApiRouter = (deps: ReviewApiDependencies): Router => {
  const router = Router()
  const { reviewStore } = deps

  // ── POST /api/reviews ─────────────────────────────────────

  router.post('/api/reviews', express.json({ limit: '5mb' }), (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const title = asString(body['title'])
      const content = asString(body['content'])

      if (title.length === 0 || content.length === 0) {
        res.status(400).json({
          error: 'Validation failed',
          details: { message: 'title and content are required' },
        })
        return
      }

      const review = reviewStore.create({
        title,
        content,
        context: asString(body['context']) || undefined,
        repoFullName: asString(body['repoFullName']) || undefined,
        branch: asString(body['branch']) || undefined,
        iteration: asPositiveInt(body['iteration']),
        metadata: asStringRecord(body['metadata']),
        ttlSeconds: asPositiveInt(body['ttlSeconds']),
      })

      res.status(201).json(serializeReview(review))
    } catch {
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ── GET /api/reviews ──────────────────────────────────────

  router.get('/api/reviews', (req, res) => {
    try {
      reviewStore.expireOverdue()
      const all = sortReviews(reviewStore.getAll().map(serializeReview))

      const page = Math.max(1, parseInt(req.query['page'] as string, 10) || 1)
      const pageSize = Math.max(1, parseInt(req.query['pageSize'] as string, 10) || 50)
      const total = all.length
      const totalPages = Math.ceil(total / pageSize)
      const startIndex = (page - 1) * pageSize
      const items = all.slice(startIndex, startIndex + pageSize)

      res.json({ items, total, page, pageSize, totalPages })
    } catch {
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ── GET /api/reviews/:id ──────────────────────────────────

  router.get('/api/reviews/:id', (req, res) => {
    try {
      reviewStore.expireOverdue()
      const review = reviewStore.get(req.params.id)
      if (review == null) {
        res.status(404).json({ error: 'Review not found' })
        return
      }
      res.json(serializeReview(review))
    } catch {
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ── POST /api/reviews/:id/decision ────────────────────────

  router.post('/api/reviews/:id/decision', express.json(), (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const decision = asString(body['decision'])

      if (decision !== 'approved' && decision !== 'rejected') {
        res.status(400).json({
          error: 'Validation failed',
          details: { message: "decision must be 'approved' or 'rejected'" },
        })
        return
      }

      // A comment is mandatory when rejecting (so the reason flows back into
      // the workflow loop) but optional when approving.
      const comment = asString(body['comment'])
      if (decision === 'rejected' && comment.length === 0) {
        res.status(400).json({
          error: 'Validation failed',
          details: { message: 'a comment is required when rejecting' },
        })
        return
      }

      const outcome = reviewStore.decide(
        req.params.id,
        decision,
        comment,
        asString(body['reviewer']) || 'dashboard',
      )

      if (outcome.kind === 'not-found') {
        res.status(404).json({ error: 'Review not found' })
        return
      }
      if (outcome.kind === 'conflict') {
        res.status(409).json({
          error: 'Review already resolved',
          review: serializeReview(outcome.review),
        })
        return
      }

      res.json(serializeReview(outcome.review))
    } catch {
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  return router
}
