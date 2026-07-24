/* eslint-disable @typescript-eslint/unbound-method */
import type { Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'

import { createAdminAuthMiddleware } from './admin-auth-middleware'

// ── Helpers ─────────────────────────────────────────────────────────

const createMockLogger = () => ({
  child: vi.fn().mockReturnThis(),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
})

const createMockReq = (authorization?: string): Partial<Request> => ({
  headers: authorization !== undefined ? { authorization } : {},
})

const createMockRes = () => {
  const res: Partial<Response> = {}
  res.status = vi.fn().mockReturnValue(res)
  res.json = vi.fn().mockReturnValue(res)
  return res as Response
}

// ── Tests ───────────────────────────────────────────────────────────

describe('createAdminAuthMiddleware', () => {
  describe('when adminApiToken is configured', () => {
    const token = 'my-secret-token'

    it('calls next() when token matches', () => {
      const logger = createMockLogger()
      const middleware = createAdminAuthMiddleware({ adminApiToken: token }, logger as never)

      const req = createMockReq(`Bearer ${token}`)
      const res = createMockRes()
      const next = vi.fn()

      middleware(req as Request, res, next)

      expect(next).toHaveBeenCalledOnce()
      expect(res.status).not.toHaveBeenCalled()
    })

    it('returns 401 when token does not match', () => {
      const logger = createMockLogger()
      const middleware = createAdminAuthMiddleware({ adminApiToken: token }, logger as never)

      const req = createMockReq('Bearer wrong-token')
      const res = createMockRes()
      const next = vi.fn()

      middleware(req as Request, res, next)

      expect(next).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({ error: 'Authentication required' })
    })

    it('returns 401 when Authorization header is missing', () => {
      const logger = createMockLogger()
      const middleware = createAdminAuthMiddleware({ adminApiToken: token }, logger as never)

      const req = createMockReq()
      const res = createMockRes()
      const next = vi.fn()

      middleware(req as Request, res, next)

      expect(next).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({ error: 'Authentication required' })
    })

    it('returns 401 when Authorization header is not Bearer scheme', () => {
      const logger = createMockLogger()
      const middleware = createAdminAuthMiddleware({ adminApiToken: token }, logger as never)

      const req = createMockReq('Basic dXNlcjpwYXNz')
      const res = createMockRes()
      const next = vi.fn()

      middleware(req as Request, res, next)

      expect(next).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({ error: 'Authentication required' })
    })

    it('returns 401 when Bearer token is empty', () => {
      const logger = createMockLogger()
      const middleware = createAdminAuthMiddleware({ adminApiToken: token }, logger as never)

      const req = createMockReq('Bearer ')
      const res = createMockRes()
      const next = vi.fn()

      middleware(req as Request, res, next)

      expect(next).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({ error: 'Authentication required' })
    })
  })

  describe('when adminApiToken is undefined (auth disabled)', () => {
    it('passes all requests through without checking headers', () => {
      const logger = createMockLogger()
      const middleware = createAdminAuthMiddleware({ adminApiToken: undefined }, logger as never)

      const req = createMockReq()
      const res = createMockRes()
      const next = vi.fn()

      middleware(req as Request, res, next)

      expect(next).toHaveBeenCalledOnce()
      expect(res.status).not.toHaveBeenCalled()
    })

    it('logs a warning once when auth is disabled', () => {
      const logger = createMockLogger()
      const middleware = createAdminAuthMiddleware({ adminApiToken: undefined }, logger as never)

      const req1 = createMockReq()
      const res1 = createMockRes()
      const next1 = vi.fn()

      const req2 = createMockReq()
      const res2 = createMockRes()
      const next2 = vi.fn()

      middleware(req1 as Request, res1, next1)
      middleware(req2 as Request, res2, next2)

      // Both requests pass through
      expect(next1).toHaveBeenCalledOnce()
      expect(next2).toHaveBeenCalledOnce()

      // Warning logged only once
      expect(logger.warn).toHaveBeenCalledTimes(1)
      expect(logger.warn).toHaveBeenCalledWith(
        'ADMIN_API_TOKEN not configured — admin API authentication is disabled',
      )
    })
  })
})
