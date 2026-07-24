/**
 * MCP server for Rocky.
 *
 * Exposes an MCP-compliant endpoint using the `@modelcontextprotocol/sdk`
 * package with Streamable HTTP transport. Registers three tools:
 * `rocky_executeTask`, `rocky_getTaskStatus`, and `rocky_cancelTask`.
 * Validates Bearer token authentication when `MCP_AUTH_TOKEN` is configured.
 *
 * A new McpServer instance is created per session because the SDK's
 * McpServer (which wraps Protocol) only supports one active transport
 * connection at a time. Tool registration is extracted into a reusable
 * `registerTools()` helper that is called for each new instance.
 */

import { randomUUID } from 'node:crypto'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import type pino from 'pino'
import { z } from 'zod'

import type {
  MCPServerConfig,
  MCPServerInstance,
  MCPTaskHandler,
  MCPTaskStore,
} from '../lib/mcp-types'

import { extractRepoFullName, isValidationError } from './mcp-task-handler'

// ── Types ───────────────────────────────────────────────────────────

interface McpServerDeps {
  taskHandler: MCPTaskHandler
  taskStore: MCPTaskStore
  logger: pino.Logger
  enqueueJob: (queueKey: string, jobFn: () => Promise<void>) => void
}

// ── Tool Registration Helper ────────────────────────────────────────

/**
 * Registers all Rocky MCP tools on the given McpServer instance.
 * Called once per session when a new McpServer is created.
 */
const registerTools = (mcpServer: McpServer, deps: McpServerDeps): void => {
  const { taskHandler, taskStore, enqueueJob } = deps

  mcpServer.registerTool(
    'rocky_executeTask',
    {
      description:
        'Submit a task to Rocky — clones a repository, runs an optional install script, and invokes Kiro CLI with the provided prompt.',
      inputSchema: {
        repoUrl: z.string(),
        baseBranch: z.string(),
        installScript: z.string().optional(),
        prompt: z.string(),
        engine: z.enum(['kiro', 'copilot']).optional(),
        agent: z.string().optional().describe('Kiro CLI agent name to use for this task'),
      },
    },
    (args) => {
      const parseResult = taskHandler.parseTaskInput(args)

      if (isValidationError(parseResult)) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(parseResult) }],
          isError: true,
        }
      }

      const repoFullName = extractRepoFullName(parseResult.repoUrl)
      const task = taskStore.create(parseResult, repoFullName)

      // Enqueue the job for async execution
      enqueueJob(task.queueKey, async () => {
        await taskHandler.executeTask(task)
      })

      // Update status to working and return initial response
      taskStore.updateStatus(task.id, 'working')

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ taskId: task.id, status: 'working' }),
          },
        ],
      }
    },
  )

  mcpServer.registerTool(
    'rocky_getTaskStatus',
    {
      description: 'Check the status and results of a previously submitted Rocky task.',
      inputSchema: {
        taskId: z.string(),
      },
    },
    (args) => {
      const task = taskStore.get(args.taskId)

      if (!task) {
        return {
          content: [{ type: 'text' as const, text: `Task not found: ${args.taskId}` }],
          isError: true,
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              taskId: task.id,
              status: task.status,
              ...(task.promptSummary != null ? { promptSummary: task.promptSummary } : {}),
              ...(task.resultSummary != null ? { resultSummary: task.resultSummary } : {}),
              ...(task.error ? { error: task.error } : {}),
              ...(task.artifacts.length > 0 ? { artifacts: task.artifacts } : {}),
            }),
          },
        ],
      }
    },
  )

  mcpServer.registerTool(
    'rocky_cancelTask',
    {
      description: 'Cancel a submitted or in-progress Rocky task.',
      inputSchema: {
        taskId: z.string(),
      },
    },
    async (args) => {
      const task = taskStore.get(args.taskId)

      if (!task) {
        return {
          content: [{ type: 'text' as const, text: `Task not found: ${args.taskId}` }],
          isError: true,
        }
      }

      const canceled = await taskHandler.cancelTask(args.taskId)

      // Re-fetch the task to get the updated status
      const updatedTask = taskStore.get(args.taskId)

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              taskId: args.taskId,
              status: updatedTask?.status ?? task.status,
              canceled,
            }),
          },
        ],
      }
    },
  )
}

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Creates an MCP server with Streamable HTTP transport, tool registration,
 * and optional Bearer token authentication.
 *
 * A new McpServer instance is created per session to avoid the SDK's
 * "Already connected to a transport" limitation. The `registerTools`
 * helper registers all three tools on each new instance.
 *
 * @param config - MCP server configuration (path, auth token)
 * @param deps - Dependencies: taskHandler, taskStore, logger, enqueueJob
 * @returns An object with the Express router
 */
export const createMCPServer = (
  config: MCPServerConfig,
  deps: McpServerDeps,
): MCPServerInstance => {
  const { logger } = deps
  const log = logger.child({ component: 'mcp-server' })

  // Log auth status at creation time
  if (config.mcpAuthToken) {
    log.info('MCP Bearer token authentication enabled')
  } else {
    log.warn('MCP_AUTH_TOKEN not configured — accepting all MCP connections without authentication')
  }

  // ── Session Tracking ──────────────────────────────────────────────

  const sessions = new Map<string, StreamableHTTPServerTransport>()

  // ── Express Router ────────────────────────────────────────────────

  const router = express.Router()

  // ── Bearer Token Middleware ────────────────────────────────────────

  const authMiddleware = (_req: Request, res: Response, next: NextFunction): void => {
    // If no auth token configured, accept all connections
    if (!config.mcpAuthToken) {
      next()
      return
    }

    const authHeader = _req.headers.authorization
    if (!authHeader) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const parts = authHeader.split(' ')
    if (parts.length !== 2 || parts[0] !== 'Bearer' || parts[1] !== config.mcpAuthToken) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    next()
  }

  // ── SSE Headers Middleware ────────────────────────────────────────

  const sseHeaders = (_req: Request, res: Response, next: NextFunction): void => {
    // Tell reverse proxies (nginx, Cloudflare) not to buffer this SSE stream.
    res.setHeader('X-Accel-Buffering', 'no')
    next()
  }

  // ── POST — Streamable HTTP Endpoint ───────────────────────────────

  // The Streamable HTTP transport handles initialization, messages, and
  // SSE streaming all on a single path via POST. Each new initialization
  // request creates a new transport/session with its own McpServer instance.

  router.post(
    config.mcpPath,
    authMiddleware,
    express.json({ type: 'application/json' }),
    async (req: Request, res: Response) => {
      const reqLog = log.child({ path: config.mcpPath })

      // Check for existing session via Mcp-Session-Id header
      const sessionId = req.headers['mcp-session-id'] as string | undefined

      if (sessionId && sessions.has(sessionId)) {
        // Route to existing session transport
        const transport = sessions.get(sessionId)
        if (!transport) {
          res.status(404).json({ error: 'Session not found' })
          return
        }
        try {
          await transport.handleRequest(req, res, req.body)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          reqLog.error({ error: message, sessionId }, 'Error handling MCP message')
          if (!res.headersSent) {
            res.status(500).json({ error: 'Internal error' })
          }
        }
        return
      }

      // New session — create a per-session McpServer and transport
      try {
        const sessionServer = new McpServer({ name: 'Rocky', version: '0.0.0' })
        registerTools(sessionServer, deps)

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        })

        // Connect the per-session McpServer to this transport
        await sessionServer.connect(transport)

        // Track session after connection (sessionId is set after handleRequest
        // processes the initialize message)
        transport.onclose = () => {
          const sid = transport.sessionId
          if (sid) {
            sessions.delete(sid)
            reqLog.info({ sessionId: sid }, 'MCP Streamable HTTP session closed')
          }
          // Close the per-session McpServer when the transport closes
          sessionServer.close().catch((err: unknown) => {
            const errMsg = err instanceof Error ? err.message : String(err)
            reqLog.error({ error: errMsg }, 'Error closing per-session McpServer')
          })
        }

        // Handle the initial request (this processes the initialize message
        // and sets the session ID in the response header)
        await transport.handleRequest(req, res, req.body)

        // Store session after handling the request so sessionId is available
        const sid = transport.sessionId
        if (sid) {
          sessions.set(sid, transport)
          reqLog.info({ sessionId: sid }, 'MCP Streamable HTTP session established')
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        reqLog.error({ error: message }, 'Failed to establish MCP Streamable HTTP session')
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal error' })
        }
      }
    },
  )

  // ── GET — SSE Stream Endpoint ─────────────────────────────────────

  // Streamable HTTP also supports GET for server-initiated SSE streams.
  // The client sends a GET with the Mcp-Session-Id header to receive
  // server-to-client notifications.

  router.get(config.mcpPath, authMiddleware, sseHeaders, async (req: Request, res: Response) => {
    const reqLog = log.child({ path: config.mcpPath })
    const sessionId = req.headers['mcp-session-id'] as string | undefined

    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({ error: 'Invalid or missing Mcp-Session-Id header' })
      return
    }

    const transport = sessions.get(sessionId)
    if (!transport) {
      res.status(400).json({ error: 'Invalid or missing Mcp-Session-Id header' })
      return
    }
    try {
      await transport.handleRequest(req, res)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      reqLog.error({ error: message, sessionId }, 'Error handling MCP GET stream')
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal error' })
      }
    }
  })

  // ── DELETE — Session Termination ──────────────────────────────────

  router.delete(config.mcpPath, authMiddleware, async (req: Request, res: Response) => {
    const reqLog = log.child({ path: config.mcpPath })
    const sessionId = req.headers['mcp-session-id'] as string | undefined

    if (!sessionId || !sessions.has(sessionId)) {
      res.status(404).json({ error: 'Session not found' })
      return
    }

    const transport = sessions.get(sessionId)
    if (!transport) {
      res.status(404).json({ error: 'Session not found' })
      return
    }
    try {
      await transport.handleRequest(req, res)
      sessions.delete(sessionId)
      reqLog.info({ sessionId }, 'MCP session terminated via DELETE')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      reqLog.error({ error: message, sessionId }, 'Error handling MCP DELETE')
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal error' })
      }
    }
  })

  return { router }
}
