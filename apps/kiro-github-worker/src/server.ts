/**
 * Express application setup for the Kiro GitHub Worker.
 *
 * Creates an Express app with:
 * - Octokit webhook middleware mounted at the configured path
 * - Health check endpoint at `/health`
 * - A2A JSON-RPC endpoint and agent card (when A2A router and agent card are provided)
 * - Global error handler that logs with stack trace and continues accepting events
 */

import type { ErrorRequestHandler, Request, Response } from 'express'
import express from 'express'
import type pino from 'pino'

import type { WebhookReceiverResult } from './components/webhook-receiver'
import type { AgentCard } from './lib/a2a-types'

// ── Types ───────────────────────────────────────────────────────────

export interface CreateServerOptions {
  /** The webhook receiver result containing the Node.js middleware. */
  webhookReceiver: WebhookReceiverResult
  /** The path at which to mount the webhook middleware (e.g. "/webhook"). */
  webhookPath: string
  /** A pino logger instance for error logging. */
  logger: pino.Logger
  /** Optional A2A Express router to mount (handles its own path). */
  a2aRouter?: express.Router
  /** Optional A2A agent card JSON to serve at `/.well-known/agent.json`. */
  agentCard?: AgentCard
  /** Optional MCP Express router to mount (handles its own path for SSE + messages). */
  mcpRouter?: express.Router
  /** Optional admin API auth middleware to apply to /api/* routes. */
  adminAuthMiddleware?: express.RequestHandler
  /** Optional admin API router to mount (handles its own /api/* paths). */
  adminRouter?: express.Router
  /** Optional review API router to mount (handles its own /api/reviews paths). */
  reviewRouter?: express.Router
}

// ── Implementation ──────────────────────────────────────────────────

/**
 * Creates and configures the Express application.
 *
 * @param options - Webhook receiver, webhook path, logger, and optional A2A components
 * @returns A configured Express application
 */
export const createServer = (options: CreateServerOptions): express.Express => {
  const {
    webhookReceiver,
    logger,
    a2aRouter,
    agentCard,
    mcpRouter,
    adminAuthMiddleware,
    adminRouter,
    reviewRouter,
  } = options
  const log = logger.child({ component: 'server' })

  const app = express()

  // Mount admin API routes before webhook middleware so /api/* takes priority.
  if (adminRouter) {
    if (adminAuthMiddleware) {
      app.use('/api', adminAuthMiddleware)
    }
    app.use(adminRouter)
    log.info('Admin API routes mounted')
  }

  // Mount review API routes. They live under /api, so they inherit the
  // admin auth middleware mounted above (when configured).
  if (reviewRouter) {
    app.use(reviewRouter)
    log.info('Review API routes mounted')
  }

  // Mount MCP routes when the router is provided.
  // The MCP router handles its own path internally, so we mount at root.
  // Mounted before webhook middleware so MCP routes are matched first.
  if (mcpRouter) {
    app.use(mcpRouter)
    log.info('MCP routes mounted')
  }

  // Mount A2A routes when both router and agent card are provided.
  // The A2A router handles its own path internally, so we mount at root.
  // The agent card endpoint requires no authentication.
  if (a2aRouter && agentCard) {
    app.use(a2aRouter)

    app.get('/.well-known/agent.json', (_req: Request, res: Response) => {
      res.setHeader('Content-Type', 'application/json')
      res.status(200).json(agentCard)
    })

    log.info('A2A routes and agent card mounted')
  }

  // Mount the Octokit webhook Node.js middleware at the root.
  // `createNodeMiddleware` handles path matching internally (configured
  // with the webhook path), so we mount at `/` to avoid double-prefixing.
  app.use(webhookReceiver.middleware)

  // Health check endpoint
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' })
  })

  // Global error handler — logs with stack trace and continues accepting events.
  // Express requires all four parameters to recognize this as an error handler.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const errorHandler: ErrorRequestHandler = (err: Error, _req, res, _next) => {
    log.error({ err, stack: err.stack }, 'Unhandled server error')
    res.status(500).json({ error: 'Internal server error' })
  }

  app.use(errorHandler)

  return app
}
