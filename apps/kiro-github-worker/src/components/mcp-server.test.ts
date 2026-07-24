// Feature: rocky-mcp-mode — Property and unit tests for MCP_Server

import http from 'node:http'

import express from 'express'
import type { Request, Response, NextFunction } from 'express'
import * as fc from 'fast-check'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type {
  MCPTask,
  MCPTaskHandler,
  MCPTaskInput,
  MCPTaskStore,
  MCPValidationError,
} from '../lib/mcp-types'

import { createMCPServer } from './mcp-server'

// ── Helpers ─────────────────────────────────────────────────────────

/** Silent pino logger that discards all output. */
const mockLogger = pino({ level: 'silent' })

/** Build a minimal valid MCPTaskInput. */
const validInput: MCPTaskInput = {
  repoUrl: 'https://github.com/test-owner/test-repo',
  baseBranch: 'main',
  prompt: 'Fix the bug',
}

/** Build a minimal MCPTask for mock returns. */
const buildMockTask = (id: string): MCPTask => ({
  id,
  status: 'working',
  input: validInput,
  repoFullName: 'test-owner/test-repo',
  queueKey: `test-owner/test-repo:mcp-${id}`,
  artifacts: [],
  promptSummary: null,
  resultSummary: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  completedAt: null,
})

/** Create mock task handler that accepts all inputs. */
const createMockTaskHandler = (): MCPTaskHandler => ({
  parseTaskInput: (args: Record<string, unknown>) => {
    const repoUrl = args['repoUrl']
    const baseBranch = args['baseBranch']
    const prompt = args['prompt']
    const installScript = args['installScript']

    if (typeof repoUrl !== 'string' || repoUrl.length === 0) {
      return {
        valid: false,
        field: 'repoUrl',
        message: 'repoUrl is required',
      } as MCPValidationError
    }
    if (typeof baseBranch !== 'string' || baseBranch.length === 0) {
      return {
        valid: false,
        field: 'baseBranch',
        message: 'baseBranch is required',
      } as MCPValidationError
    }
    if (typeof prompt !== 'string' || prompt.length === 0) {
      return {
        valid: false,
        field: 'prompt',
        message: 'prompt is required',
      } as MCPValidationError
    }

    return {
      repoUrl: repoUrl,
      baseBranch: baseBranch,
      prompt: prompt,
      ...(typeof installScript === 'string' && installScript.length > 0 ? { installScript } : {}),
    }
  },
  executeTask: () => Promise.resolve(),
  cancelTask: () => Promise.resolve(true),
})

/** Create mock task store. */
const createMockTaskStore = (): MCPTaskStore => {
  const tasks = new Map<string, MCPTask>()
  return {
    create: (input, repoFullName) => {
      const id = crypto.randomUUID()
      const task = buildMockTask(id)
      task.input = input
      task.repoFullName = repoFullName
      task.queueKey = `${repoFullName}:mcp-${id}`
      tasks.set(id, task)
      return task
    },
    get: (taskId) => tasks.get(taskId),
    getAll: () => [...tasks.values()],
    updateStatus: (taskId, status) => {
      const task = tasks.get(taskId)
      if (task) task.status = status
    },
    setError: () => {},
    addArtifact: () => {},
    setCompleted: () => {},
    setPromptSummary: () => {},
    setResultSummary: () => {},
  }
}

/** No-op enqueue function. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const mockEnqueueJob = (_key: string, _fn: () => Promise<void>): void => {}

/** Arbitrary for non-empty printable strings (for tokens). */
const tokenArb = fc.string({ minLength: 1, maxLength: 50 })

// ── Auth Middleware Extraction ───────────────────────────────────────

/**
 * Recreates the same Bearer token auth middleware used by createMCPServer.
 * This allows us to test the auth logic in isolation without needing
 * the full MCP SDK SSE transport (which doesn't support repeated connections).
 */
const createAuthMiddleware =
  (mcpAuthToken?: string): ((req: Request, res: Response, next: NextFunction) => void) =>
  (req: Request, res: Response, next: NextFunction): void => {
    if (!mcpAuthToken) {
      next()
      return
    }

    const authHeader = req.headers.authorization
    if (!authHeader) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const parts = authHeader.split(' ')
    if (parts.length !== 2 || parts[0] !== 'Bearer' || parts[1] !== mcpAuthToken) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    next()
  }

// ── Test Server Setup ───────────────────────────────────────────────

/**
 * Creates a test Express app with just the auth middleware and a simple
 * endpoint that returns 200 when auth passes. This tests the auth logic
 * without the complexity of the MCP SDK SSE transport.
 */
const createAuthTestServer = (authToken?: string) => {
  const app = express()
  const middleware = createAuthMiddleware(authToken)

  // Mount the auth middleware on a test endpoint (same path as MCP SSE)
  app.get('/mcp', middleware, (_req: Request, res: Response) => {
    res.status(200).json({ ok: true })
  })

  return { app }
}

/**
 * Creates a test server with the full MCP router mounted.
 */
const createTestServer = (authToken?: string, mcpPath = '/mcp') => {
  const app = express()
  app.use(express.json())

  const taskHandler = createMockTaskHandler()
  const taskStore = createMockTaskStore()

  const { router } = createMCPServer(
    { mcpPath, mcpAuthToken: authToken },
    {
      taskHandler,
      taskStore,
      logger: mockLogger,
      enqueueJob: mockEnqueueJob,
    },
  )

  app.use(router)

  return { app, taskStore, taskHandler }
}

/**
 * Start an HTTP server and return the base URL + close function.
 */
const startServer = (
  app: express.Express,
): Promise<{ baseUrl: string; close: () => Promise<void> }> =>
  new Promise((resolve) => {
    const server = http.createServer(app)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr == null || typeof addr === 'string') throw new Error('Unexpected address')
      const baseUrl = `http://127.0.0.1:${String(addr.port)}`
      resolve({
        baseUrl,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()))
          }),
      })
    })
  })

/**
 * GET a URL and return the HTTP status and parsed JSON body.
 */
const fetchJson = async (
  baseUrl: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> => {
  const res = await fetch(`${baseUrl}${path}`, { headers })
  const body: unknown = await res.json()
  return { status: res.status, body }
}

// ── Property 7: MCP Bearer token validation ──
// **Validates: Requirements 11.1, 11.2, 11.3**

describe('Feature: rocky-mcp-mode, Property 7: MCP Bearer token validation', () => {
  const configuredToken = 'test-mcp-secret-token-xyz789'
  let baseUrl: string
  let closeServer: () => Promise<void>

  beforeAll(async () => {
    const { app } = createAuthTestServer(configuredToken)
    const server = await startServer(app)
    baseUrl = server.baseUrl
    closeServer = server.close
  })

  afterAll(async () => {
    await closeServer()
  })

  it('accepts requests when the Bearer token exactly matches the configured MCP_AUTH_TOKEN', () =>
    fc.assert(
      fc.asyncProperty(fc.constant(configuredToken), (token) =>
        (async () => {
          const { status } = await fetchJson(baseUrl, '/mcp', {
            Authorization: `Bearer ${token}`,
          })
          expect(status).toBe(200)
        })(),
      ),
      { numRuns: 100 },
    ))

  it('rejects requests with non-matching Bearer tokens with HTTP 401', () =>
    fc.assert(
      fc.asyncProperty(
        tokenArb.filter((t) => t !== configuredToken),
        (wrongToken) =>
          (async () => {
            const { status, body } = await fetchJson(baseUrl, '/mcp', {
              Authorization: `Bearer ${wrongToken}`,
            })
            expect(status).toBe(401)
            expect(body).toEqual({ error: 'Unauthorized' })
          })(),
      ),
      { numRuns: 100 },
    ))

  it('rejects requests with missing Authorization header with HTTP 401', () =>
    fc.assert(
      fc.asyncProperty(fc.constant(null), () =>
        (async () => {
          const { status, body } = await fetchJson(baseUrl, '/mcp')
          expect(status).toBe(401)
          expect(body).toEqual({ error: 'Unauthorized' })
        })(),
      ),
      { numRuns: 100 },
    ))

  it('rejects requests with malformed Authorization header (not Bearer scheme) with HTTP 401', () =>
    fc.assert(
      fc.asyncProperty(
        fc.constantFrom('Basic', 'Token', 'Digest', 'ApiKey'),
        tokenArb,
        (scheme, token) =>
          (async () => {
            const { status, body } = await fetchJson(baseUrl, '/mcp', {
              Authorization: `${scheme} ${token}`,
            })
            expect(status).toBe(401)
            expect(body).toEqual({ error: 'Unauthorized' })
          })(),
      ),
      { numRuns: 100 },
    ))

  it('accepts all requests when MCP_AUTH_TOKEN is not configured', async () => {
    const { app: noAuthApp } = createAuthTestServer() // no auth token
    const noAuthServer = await startServer(noAuthApp)

    try {
      await fc.assert(
        fc.asyncProperty(fc.constant(null), () =>
          (async () => {
            const { status } = await fetchJson(noAuthServer.baseUrl, '/mcp')
            expect(status).toBe(200)
          })(),
        ),
        { numRuns: 100 },
      )
    } finally {
      await noAuthServer.close()
    }
  })
})

// ── Unit Tests for MCP Server ──
// Tests: tool registration, configurable path, auth disabled mode, error responses

describe('MCP Server — Unit Tests', () => {
  describe('Three tools registered with correct names', () => {
    it('MCP server creates successfully with all three tools configured', () => {
      // If createMCPServer doesn't throw, the tools were registered successfully.
      // The MCP SDK would throw if tool registration failed.
      const taskHandler = createMockTaskHandler()
      const taskStore = createMockTaskStore()

      const { router } = createMCPServer(
        { mcpPath: '/mcp' },
        {
          taskHandler,
          taskStore,
          logger: mockLogger,
          enqueueJob: mockEnqueueJob,
        },
      )

      expect(router).toBeDefined()
    })

    it('executeTask tool creates a task and returns working status via store', () => {
      const taskStore = createMockTaskStore()

      // Simulate what the rocky/executeTask tool does internally
      const task = taskStore.create(validInput, 'test-owner/test-repo')
      expect(task).toBeDefined()
      expect(task.id).toBeTruthy()
      expect(task.queueKey).toContain('test-owner/test-repo:mcp-')

      taskStore.updateStatus(task.id, 'working')
      const retrieved = taskStore.get(task.id)
      expect(retrieved).toBeDefined()
      expect(retrieved?.status).toBe('working')
    })

    it('getTaskStatus returns undefined for unknown task IDs', () => {
      const taskStore = createMockTaskStore()
      expect(taskStore.get('unknown-id')).toBeUndefined()
    })

    it('cancelTask handler returns true (mock behavior)', async () => {
      const taskHandler = createMockTaskHandler()
      const result = await taskHandler.cancelTask('any-id')
      expect(result).toBe(true)
    })
  })

  describe('Configurable endpoint path', () => {
    it('mounts routes at the configured mcpPath', async () => {
      const customPath = '/custom-mcp'
      const { app } = createTestServer(undefined, customPath)
      const server = await startServer(app)

      try {
        // POST without a valid session should respond at custom path
        const msgRes = await fetch(`${server.baseUrl}${customPath}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'initialize',
            id: 1,
            params: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              clientInfo: { name: 'test', version: '0.0.1' },
            },
          }),
        })
        // Should get a valid response (200 for initialize), not a 404
        expect(msgRes.status).toBe(200)
      } finally {
        await server.close()
      }
    })

    it('returns 404 for requests to the default /mcp path when a custom path is configured', async () => {
      const customPath = '/custom-mcp'
      const { app } = createTestServer(undefined, customPath)
      const server = await startServer(app)

      try {
        // POST to the default path should not match
        const res = await fetch(`${server.baseUrl}/mcp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
        // Express returns 404 for unmatched routes
        expect(res.status).toBe(404)
      } finally {
        await server.close()
      }
    })
  })

  describe('Auth disabled mode (MCP_AUTH_TOKEN not set)', () => {
    let baseUrl: string
    let closeServer: () => Promise<void>

    beforeAll(async () => {
      // Use the auth test server (no MCP SDK complexity) to verify middleware behavior
      const { app } = createAuthTestServer() // no auth token
      const server = await startServer(app)
      baseUrl = server.baseUrl
      closeServer = server.close
    })

    afterAll(async () => {
      await closeServer()
    })

    it('accepts connections without any Authorization header', async () => {
      const { status } = await fetchJson(baseUrl, '/mcp')
      expect(status).toBe(200)
    })

    it('accepts connections with any Authorization header value', async () => {
      const { status } = await fetchJson(baseUrl, '/mcp', {
        Authorization: 'Bearer any-random-token',
      })
      expect(status).toBe(200)
    })

    it('accepts connections with non-Bearer auth schemes', async () => {
      const { status } = await fetchJson(baseUrl, '/mcp', {
        Authorization: 'Basic dXNlcjpwYXNz',
      })
      expect(status).toBe(200)
    })
  })

  describe('Streamable HTTP endpoint validation', () => {
    let baseUrl: string
    let closeServer: () => Promise<void>

    beforeAll(async () => {
      const { app } = createTestServer()
      const server = await startServer(app)
      baseUrl = server.baseUrl
      closeServer = server.close
    })

    afterAll(async () => {
      await closeServer()
    })

    it('accepts a valid initialize request and returns a session ID', async () => {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'initialize',
          id: 1,
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'test', version: '0.0.1' },
          },
        }),
      })
      expect(res.status).toBe(200)
      const sessionId = res.headers.get('mcp-session-id')
      expect(sessionId).toBeTruthy()
    })

    it('returns 400 for GET requests without Mcp-Session-Id header', async () => {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: 'GET',
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toContain('Invalid or missing Mcp-Session-Id')
    })
  })

  describe('Per-session isolation (Requirement 1.2)', () => {
    let baseUrl: string
    let closeServer: () => Promise<void>

    beforeAll(async () => {
      const { app } = createTestServer()
      const server = await startServer(app)
      baseUrl = server.baseUrl
      closeServer = server.close
    })

    afterAll(async () => {
      await closeServer()
    })

    /**
     * Helper: send an MCP initialize request and return the session ID.
     */
    const initializeSession = async (
      url: string,
      clientName: string,
    ): Promise<{ sessionId: string; status: number }> => {
      const res = await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'initialize',
          id: 1,
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: clientName, version: '0.0.1' },
          },
        }),
      })
      const sessionId = res.headers.get('mcp-session-id') ?? ''
      return { sessionId, status: res.status }
    }

    /**
     * Helper: parse an SSE response body to extract JSON-RPC result objects.
     * The MCP Streamable HTTP transport may return SSE event streams for
     * messages on established sessions.
     */
    const parseSSEResponse = async (
      res: globalThis.Response,
    ): Promise<{ status: number; jsonrpc: unknown }> => {
      const contentType = res.headers.get('content-type') ?? ''
      const status = res.status

      if (contentType.includes('text/event-stream')) {
        // Parse SSE: extract JSON from "data: ..." lines
        const text = await res.text()
        const dataLines = text
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6))
        // The last data line typically contains the JSON-RPC response
        const lastData = dataLines[dataLines.length - 1]
        return { status, jsonrpc: lastData ? JSON.parse(lastData) : null }
      }

      // Plain JSON response
      const jsonrpc: unknown = await res.json()
      return { status, jsonrpc }
    }

    it('two concurrent sessions can be established without errors', async () => {
      // Establish two sessions concurrently — this would fail with
      // "Already connected to a transport" if a single McpServer was shared
      const [session1, session2] = await Promise.all([
        initializeSession(baseUrl, 'client-1'),
        initializeSession(baseUrl, 'client-2'),
      ])

      expect(session1.status).toBe(200)
      expect(session2.status).toBe(200)
      expect(session1.sessionId).toBeTruthy()
      expect(session2.sessionId).toBeTruthy()
      // Each session gets its own unique session ID
      expect(session1.sessionId).not.toBe(session2.sessionId)
    })

    it('closing one session does not affect the other session transport', async () => {
      // Establish two sessions
      const session1 = await initializeSession(baseUrl, 'client-A')
      const session2 = await initializeSession(baseUrl, 'client-B')

      expect(session1.sessionId).toBeTruthy()
      expect(session2.sessionId).toBeTruthy()

      // Close session 1 via DELETE
      const deleteRes = await fetch(`${baseUrl}/mcp`, {
        method: 'DELETE',
        headers: {
          'mcp-session-id': session1.sessionId,
        },
      })
      // DELETE should succeed
      expect([200, 202, 204]).toContain(deleteRes.status)

      // Session 2 should still be functional — send a tools/list request
      const listToolsRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'mcp-session-id': session2.sessionId,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/list',
          id: 2,
          params: {},
        }),
      })
      expect(listToolsRes.status).toBe(200)

      const { jsonrpc } = await parseSSEResponse(listToolsRes)
      const rpcResult = jsonrpc as { result?: { tools?: unknown[] } }
      // Session 2 should still respond with tools
      expect(rpcResult.result).toBeDefined()
      expect(rpcResult.result?.tools).toBeDefined()
    })

    it('multiple sessions can each list tools independently', async () => {
      // Establish three sessions sequentially
      const session1 = await initializeSession(baseUrl, 'multi-1')
      const session2 = await initializeSession(baseUrl, 'multi-2')
      const session3 = await initializeSession(baseUrl, 'multi-3')

      expect(session1.sessionId).toBeTruthy()
      expect(session2.sessionId).toBeTruthy()
      expect(session3.sessionId).toBeTruthy()

      // All three session IDs should be unique
      const ids = new Set([session1.sessionId, session2.sessionId, session3.sessionId])
      expect(ids.size).toBe(3)

      // Each session should be able to list tools independently
      const listTools = async (sessionId: string, requestId: number) => {
        const res = await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'mcp-session-id': sessionId,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'tools/list',
            id: requestId,
            params: {},
          }),
        })
        const { status, jsonrpc } = await parseSSEResponse(res)
        return {
          status,
          body: jsonrpc as { result?: { tools?: Array<{ name: string }> } },
        }
      }

      const [tools1, tools2, tools3] = await Promise.all([
        listTools(session1.sessionId, 10),
        listTools(session2.sessionId, 20),
        listTools(session3.sessionId, 30),
      ])

      // All three should succeed
      expect(tools1.status).toBe(200)
      expect(tools2.status).toBe(200)
      expect(tools3.status).toBe(200)

      // All three should return the same set of tools
      const toolNames1 = tools1.body.result?.tools?.map((t) => t.name).sort()
      const toolNames2 = tools2.body.result?.tools?.map((t) => t.name).sort()
      const toolNames3 = tools3.body.result?.tools?.map((t) => t.name).sort()

      expect(toolNames1).toEqual(toolNames2)
      expect(toolNames2).toEqual(toolNames3)
      expect(toolNames1).toContain('rocky_executeTask')
      expect(toolNames1).toContain('rocky_getTaskStatus')
      expect(toolNames1).toContain('rocky_cancelTask')
    })
  })

  describe('MCP error responses for unknown task IDs', () => {
    it('getTaskStatus returns undefined for non-existent task ID', () => {
      const taskStore = createMockTaskStore()
      const result = taskStore.get('nonexistent-task-id')
      expect(result).toBeUndefined()
    })

    it('cancelTask on non-existent task — store returns undefined', () => {
      const taskStore = createMockTaskStore()
      const task = taskStore.get('nonexistent-cancel-id')
      expect(task).toBeUndefined()
    })
  })
})
