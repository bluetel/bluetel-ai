/* eslint-disable @typescript-eslint/no-non-null-assertion */

import pino from 'pino'
import { describe, expect, it } from 'vitest'

import { createReviewStore } from './review-store'

/** Silent pino logger that discards all output. */
const mockLogger = pino({ level: 'silent' })

describe('createReviewStore', () => {
  it('creates a pending review with defaults', () => {
    const store = createReviewStore(mockLogger)
    const review = store.create({ title: 'Review diff', content: 'diff --git ...' })

    expect(review.status).toBe('pending')
    expect(review.decision).toBeNull()
    expect(review.comment).toBe('')
    expect(review.reviewer).toBe('')
    expect(review.expiresAt).toBeNull()
    expect(store.get(review.id)).toBe(review)
  })

  it('sets expiresAt when a ttl is provided', () => {
    const store = createReviewStore(mockLogger)
    const before = Date.now()
    const review = store.create({ title: 't', content: 'c', ttlSeconds: 3600 })

    expect(review.expiresAt).not.toBeNull()
    expect(review.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 3600 * 1000)
  })

  it('strips ANSI escape codes from content', () => {
    const store = createReviewStore(mockLogger)
    const review = store.create({ title: 't', content: '\x1b[31m' + 'red' + '\x1b[0m' })
    expect(review.content).toBe('red')
  })

  it('records an approve decision', () => {
    const store = createReviewStore(mockLogger)
    const review = store.create({ title: 't', content: 'c' })
    const outcome = store.decide(review.id, 'approved', 'looks good', 'harry')

    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') throw new Error('expected ok')
    expect(outcome.review.status).toBe('approved')
    expect(outcome.review.decision).toBe('approved')
    expect(outcome.review.comment).toBe('looks good')
    expect(outcome.review.reviewer).toBe('harry')
    expect(outcome.review.decidedAt).not.toBeNull()
  })

  it('returns not-found for unknown ids', () => {
    const store = createReviewStore(mockLogger)
    expect(store.decide('nope', 'approved', '', '').kind).toBe('not-found')
  })

  it('rejects deciding an already-decided review', () => {
    const store = createReviewStore(mockLogger)
    const review = store.create({ title: 't', content: 'c' })
    store.decide(review.id, 'approved', '', 'a')
    const outcome = store.decide(review.id, 'rejected', '', 'b')

    expect(outcome.kind).toBe('conflict')
    if (outcome.kind !== 'conflict') throw new Error('expected conflict')
    expect(outcome.review.status).toBe('approved')
  })

  it('expires only overdue pending reviews', () => {
    const store = createReviewStore(mockLogger)
    const stale = store.create({ title: 'stale', content: 'c', ttlSeconds: 1 })
    const fresh = store.create({ title: 'fresh', content: 'c', ttlSeconds: 3600 })
    const decided = store.create({ title: 'decided', content: 'c', ttlSeconds: 1 })
    store.decide(decided.id, 'approved', '', 'a')

    const future = new Date(Date.now() + 10_000)
    const count = store.expireOverdue(future)

    expect(count).toBe(1)
    expect(store.get(stale.id)!.status).toBe('expired')
    expect(store.get(fresh.id)!.status).toBe('pending')
    expect(store.get(decided.id)!.status).toBe('approved')
  })
})
