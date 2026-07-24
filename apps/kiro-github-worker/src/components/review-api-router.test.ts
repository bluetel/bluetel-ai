/**
 * Unit tests for review-api-router.ts — review create/list/get/decide
 * endpoints and the sortReviews helper.
 */

/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import http from 'node:http'

import express from 'express'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createReviewApiRouter, sortReviews } from './review-api-router'
import type { SerializedReview } from './review-api-router'
import { createReviewStore } from './review-store'

const logger = pino({ level: 'silent' })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const startServer = (): Promise<{
  baseUrl: string
  close: () => Promise<void>
}> => {
  const app = express()
  app.use(createReviewApiRouter({ reviewStore: createReviewStore(logger), logger }))
  return new Promise((resolve) => {
    const server = http.createServer(app)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr == null || typeof addr === 'string') throw new Error('Unexpected address')
      resolve({
        baseUrl: `http://127.0.0.1:${String(addr.port)}`,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

const post = async (url: string, body: unknown): Promise<{ status: number; body: Json }> => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

const getJson = async (url: string): Promise<{ status: number; body: Json }> => {
  const res = await fetch(url)
  return { status: res.status, body: await res.json() }
}

describe('review API router', () => {
  let baseUrl: string
  let close: () => Promise<void>

  beforeEach(async () => {
    const server = await startServer()
    baseUrl = server.baseUrl
    close = server.close
  })

  afterEach(async () => {
    await close()
  })

  it('creates a pending review and fetches it back', async () => {
    const created = await post(`${baseUrl}/api/reviews`, {
      title: 'Review diff',
      content: 'diff --git a b',
      iteration: 2,
    })
    expect(created.status).toBe(201)
    expect(created.body.status).toBe('pending')
    expect(created.body.iteration).toBe(2)

    const fetched = await getJson(`${baseUrl}/api/reviews/${created.body.id}`)
    expect(fetched.status).toBe(200)
    expect(fetched.body.content).toBe('diff --git a b')
  })

  it('rejects creation without title or content', async () => {
    const res = await post(`${baseUrl}/api/reviews`, { title: 'only title' })
    expect(res.status).toBe(400)
  })

  it('records a decision and surfaces it on the review', async () => {
    const created = await post(`${baseUrl}/api/reviews`, { title: 't', content: 'c' })
    const decided = await post(`${baseUrl}/api/reviews/${created.body.id}/decision`, {
      decision: 'approved',
      comment: 'ship it',
      reviewer: 'harry',
    })

    expect(decided.status).toBe(200)
    expect(decided.body.status).toBe('approved')
    expect(decided.body.comment).toBe('ship it')
    expect(decided.body.reviewer).toBe('harry')
  })

  it('returns 409 when deciding an already-resolved review', async () => {
    const created = await post(`${baseUrl}/api/reviews`, { title: 't', content: 'c' })
    await post(`${baseUrl}/api/reviews/${created.body.id}/decision`, { decision: 'approved' })
    const again = await post(`${baseUrl}/api/reviews/${created.body.id}/decision`, {
      decision: 'rejected',
      comment: 'changed my mind',
    })
    expect(again.status).toBe(409)
  })

  it('validates the decision value', async () => {
    const created = await post(`${baseUrl}/api/reviews`, { title: 't', content: 'c' })
    const res = await post(`${baseUrl}/api/reviews/${created.body.id}/decision`, {
      decision: 'maybe',
    })
    expect(res.status).toBe(400)
  })

  it('requires a comment when rejecting', async () => {
    const created = await post(`${baseUrl}/api/reviews`, { title: 't', content: 'c' })
    const res = await post(`${baseUrl}/api/reviews/${created.body.id}/decision`, {
      decision: 'rejected',
    })
    expect(res.status).toBe(400)
    expect(created.body.status).toBe('pending') // not consumed by the failed attempt
  })

  it('allows rejecting with a comment', async () => {
    const created = await post(`${baseUrl}/api/reviews`, { title: 't', content: 'c' })
    const res = await post(`${baseUrl}/api/reviews/${created.body.id}/decision`, {
      decision: 'rejected',
      comment: 'please rename the variable',
    })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('rejected')
    expect(res.body.comment).toBe('please rename the variable')
  })

  it('allows approving without a comment', async () => {
    const created = await post(`${baseUrl}/api/reviews`, { title: 't', content: 'c' })
    const res = await post(`${baseUrl}/api/reviews/${created.body.id}/decision`, {
      decision: 'approved',
    })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('approved')
  })

  it('404s an unknown review', async () => {
    const res = await getJson(`${baseUrl}/api/reviews/nope`)
    expect(res.status).toBe(404)
  })
})

describe('sortReviews', () => {
  const make = (over: Partial<SerializedReview>): SerializedReview => ({
    id: 'x',
    status: 'pending',
    title: 't',
    content: 'c',
    context: null,
    repoFullName: null,
    branch: null,
    iteration: null,
    metadata: {},
    decision: null,
    comment: '',
    reviewer: '',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    decidedAt: null,
    expiresAt: null,
    ...over,
  })

  it('orders pending before resolved, oldest pending first', () => {
    const sorted = sortReviews([
      make({ id: 'resolved', status: 'approved', updatedAt: '2024-01-03T00:00:00.000Z' }),
      make({ id: 'new-pending', updatedAt: '2024-01-02T00:00:00.000Z' }),
      make({ id: 'old-pending', updatedAt: '2024-01-01T00:00:00.000Z' }),
    ])
    expect(sorted.map((r) => r.id)).toEqual(['old-pending', 'new-pending', 'resolved'])
  })
})
