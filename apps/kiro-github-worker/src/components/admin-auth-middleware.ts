/**
 * Admin API authentication middleware.
 *
 * Validates `Authorization: Bearer <token>` headers against the configured
 * `ADMIN_API_TOKEN`. When no token is configured, authentication is disabled
 * and all requests pass through (with a one-time warning logged).
 */

import type { RequestHandler } from 'express'
import type pino from 'pino'

// ── Types ───────────────────────────────────────────────────────────

export interface AdminAuthMiddlewareOptions {
  adminApiToken?: string
}

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Creates Express middleware that validates bearer token authentication
 * for admin API endpoints.
 *
 * @param options - Configuration containing the expected admin API token
 * @param logger - Pino logger instance for warning/info messages
 * @returns Express request handler middleware
 */
export const createAdminAuthMiddleware = (
  options: AdminAuthMiddlewareOptions,
  logger: pino.Logger,
): RequestHandler => {
  const log = logger.child({ component: 'admin-auth' })
  let warnedOnce = false

  return (req, res, next) => {
    // When no token is configured, auth is disabled — pass all requests through
    if (options.adminApiToken === undefined) {
      if (!warnedOnce) {
        log.warn('ADMIN_API_TOKEN not configured — admin API authentication is disabled')
        warnedOnce = true
      }
      next()
      return
    }

    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }

    const token = authHeader.slice('Bearer '.length)
    if (token !== options.adminApiToken) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }

    next()
  }
}
