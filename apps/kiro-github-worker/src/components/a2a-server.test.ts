// Feature: rocky-a2a-mode — Property tests for A2A_Server

import http from 'node:http'

import express from 'express'
import * as fc from 'fast-check'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type {
  A2ATask,
  A2ATaskHandler,
  A2ATaskInput,
  A2ATaskStore,
  JsonRpcErrorResponse,
} from '../lib/a2a-types'

import { createA2AServer } from './a2a-server'

// ── Helpers ─────────────────────────────────────────────────────────

/** Silent pino logger that discards all output. */
const mockLogger = pino({ level: 'silent' })

/** Build a minimal valid A2ATaskInput. */
const validInput: A2ATaskInput = {
  repoUrl: 'https://github.com/test-owner/test-repo',
  baseBranch: 'main',
  prompt: 'Fix the bug',
}

/** Build a minimal A2ATask for mock returns. */
const buildMockTask = (id: string): A2ATask => ({
  id,
  status: 'working',
  input: validInput,
  repoFullName: 'test-owner/test-repo',
  queueKey: `test-owner/test-repo:a2a-${id}`,
  artifacts: [],
  promptSummary: null,
  resultSummary: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  completedAt: null,
})

/** Create mock task handler that accepts all inputs. */
const createMockTaskHandler = (): A2ATaskHandler => ({
  parseTaskInput: () => validInput,
  executeTask: () => Promise.resolve(),
  cancelTask: () => Promise.resolve(true),
})

/** Create mock task store. */
const createMockTaskStore = (): A2ATaskStore => {
  const tasks = new Map<string, A2ATask>()
  return {
    create: (input, repoFullName) => {
      const id = crypto.randomUUID()
      const task = buildMockTask(id)
      task.input = input
      task.repoFullName = repoFullName
      task.queueKey = `${repoFullName}:a2a-${id}`
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

/** Build a valid tasks/send JSON-RPC body. */
const buildValidSendBody = (id: string | number = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'tasks/send',
  params: {
    message: {
      role: 'user',
      parts: [
        {
          type: 'text',
          text: JSON.stringify(validInput),
        },
      ],
    },
  },
})

/** POST JSON to the server and return the parsed response. */
const postJson = async (
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> => {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const json: unknown = await res.json()
  return { status: res.status, body: json }
}

// ── Arbitraries ─────────────────────────────────────────────────────

/** Arbitrary for valid JSON-RPC id values (string or number). */
const jsonRpcIdArb: fc.Arbitrary<string | number> = fc.oneof(
  fc.integer({ min: 1, max: 999999 }),
  fc.string({ minLength: 1, maxLength: 20 }),
)

/** Arbitrary for valid A2A method names. */
const validMethodArb = fc.constantFrom('tasks/send', 'tasks/get', 'tasks/cancel')

/** Arbitrary for invalid method names (not one of the three valid ones). */
const invalidMethodArb = fc
  .string({ minLength: 1, maxLength: 30 })
  .filter((s) => !['tasks/send', 'tasks/get', 'tasks/cancel'].includes(s))

/** Arbitrary for non-empty printable strings (for tokens). */
const tokenArb = fc.string({ minLength: 1, maxLength: 50 })

// ── Test Setup ──────────────────────────────────────────────────────

/**
 * Creates a test server with the A2A router mounted.
 * Returns the base URL and a cleanup function.
 */
const createTestServer = (authToken?: string) => {
  const app = express()
  const taskHandler = createMockTaskHandler()
  const taskStore = createMockTaskStore()

  const { router } = createA2AServer(
    { a2aPath: '/a2a', a2aAuthToken: authToken },
    {
      taskHandler,
      taskStore,
      logger: mockLogger,
      enqueueJob: mockEnqueueJob,
    },
  )

  app.use(router)

  return { app, taskStore }
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

// ── Property 1: JSON-RPC request validation ──
// **Validates: Requirements 1.2, 1.3**

describe('Property 1: JSON-RPC request validation accepts valid requests and rejects invalid ones with correct error codes', () => {
  let baseUrl: string
  let closeServer: () => Promise<void>

  beforeAll(async () => {
    const { app } = createTestServer() // no auth token — accept all
    const server = await startServer(app)
    baseUrl = server.baseUrl
    closeServer = server.close
  })

  afterAll(async () => {
    await closeServer()
  })

  it('accepts valid JSON-RPC requests with any valid id, valid method, and valid params', () =>
    fc.assert(
      fc.asyncProperty(jsonRpcIdArb, (id) =>
        (async () => {
          // Use tasks/send with valid params
          const body = buildValidSendBody(id)
          const res = await postJson(baseUrl, '/a2a', body)

          // Should be a success response (no error field)
          const resBody = res.body as Record<string, unknown>
          expect(resBody).toHaveProperty('jsonrpc', '2.0')
          expect(resBody).not.toHaveProperty('error')
          expect(resBody).toHaveProperty('result')
        })(),
      ),
      { numRuns: 100 },
    ))

  it('rejects requests with missing jsonrpc field with error code -32600', () =>
    fc.assert(
      fc.asyncProperty(jsonRpcIdArb, validMethodArb, (id, method) =>
        (async () => {
          const body = {
            id,
            method,
            params: { message: { role: 'user', parts: [{ type: 'text', text: '{}' }] } },
          }
          // Missing jsonrpc field
          const res = await postJson(baseUrl, '/a2a', body)

          const resBody = res.body as JsonRpcErrorResponse
          expect(resBody).toHaveProperty('jsonrpc', '2.0')
          expect(resBody).toHaveProperty('error')
          expect(resBody.error.code).toBe(-32600)
        })(),
      ),
      { numRuns: 100 },
    ))

  it('rejects requests with wrong jsonrpc version with error code -32600', () =>
    fc.assert(
      fc.asyncProperty(
        jsonRpcIdArb,
        validMethodArb,
        fc.string({ minLength: 1, maxLength: 5 }).filter((s) => s !== '2.0'),
        (id, method, badVersion) =>
          (async () => {
            const body = { jsonrpc: badVersion, id, method, params: {} }
            const res = await postJson(baseUrl, '/a2a', body)

            const resBody = res.body as JsonRpcErrorResponse
            expect(resBody).toHaveProperty('jsonrpc', '2.0')
            expect(resBody).toHaveProperty('error')
            expect(resBody.error.code).toBe(-32600)
          })(),
      ),
      { numRuns: 100 },
    ))

  it('rejects requests with missing or invalid id with error code -32600', () =>
    fc.assert(
      fc.asyncProperty(
        validMethodArb,
        fc.constantFrom(undefined, null, true, false, [], {}),
        (method, badId) =>
          (async () => {
            const body = { jsonrpc: '2.0', id: badId, method, params: {} }
            const res = await postJson(baseUrl, '/a2a', body)

            const resBody = res.body as JsonRpcErrorResponse
            expect(resBody).toHaveProperty('jsonrpc', '2.0')
            expect(resBody).toHaveProperty('error')
            expect(resBody.error.code).toBe(-32600)
          })(),
      ),
      { numRuns: 100 },
    ))

  it('rejects requests with unknown method with error code -32601', () =>
    fc.assert(
      fc.asyncProperty(jsonRpcIdArb, invalidMethodArb, (id, badMethod) =>
        (async () => {
          const body = { jsonrpc: '2.0', id, method: badMethod, params: {} }
          const res = await postJson(baseUrl, '/a2a', body)

          const resBody = res.body as JsonRpcErrorResponse
          expect(resBody).toHaveProperty('jsonrpc', '2.0')
          expect(resBody).toHaveProperty('error')
          expect(resBody.error.code).toBe(-32601)
        })(),
      ),
      { numRuns: 100 },
    ))

  it('rejects requests with invalid params (null, array, or non-object) with error code -32602', () =>
    fc.assert(
      fc.asyncProperty(
        jsonRpcIdArb,
        validMethodArb,
        fc.constantFrom(null, [1, 2], 'string-params', 42),
        (id, method, badParams) =>
          (async () => {
            const body = { jsonrpc: '2.0', id, method, params: badParams }
            const res = await postJson(baseUrl, '/a2a', body)

            const resBody = res.body as JsonRpcErrorResponse
            expect(resBody).toHaveProperty('jsonrpc', '2.0')
            expect(resBody).toHaveProperty('error')
            expect(resBody.error.code).toBe(-32602)
          })(),
      ),
      { numRuns: 100 },
    ))
})

// ── Property 7: A2A Bearer token validation ──
// **Validates: Requirements 9.1, 9.2, 9.3**

describe('Property 7: A2A Bearer token validation', () => {
  const configuredToken = 'test-secret-token-abc123'
  let baseUrl: string
  let closeServer: () => Promise<void>

  beforeAll(async () => {
    const { app } = createTestServer(configuredToken)
    const server = await startServer(app)
    baseUrl = server.baseUrl
    closeServer = server.close
  })

  afterAll(async () => {
    await closeServer()
  })

  it('accepts requests when the Bearer token exactly matches the configured A2A_AUTH_TOKEN', () =>
    fc.assert(
      fc.asyncProperty(jsonRpcIdArb, (id) =>
        (async () => {
          const body = buildValidSendBody(id)
          const res = await postJson(baseUrl, '/a2a', body, {
            Authorization: `Bearer ${configuredToken}`,
          })

          const resBody = res.body as Record<string, unknown>
          expect(resBody).toHaveProperty('jsonrpc', '2.0')
          expect(resBody).not.toHaveProperty('error')
          expect(resBody).toHaveProperty('result')
        })(),
      ),
      { numRuns: 100 },
    ))

  it('rejects requests with non-matching Bearer tokens with error code -32001', () =>
    fc.assert(
      fc.asyncProperty(
        jsonRpcIdArb,
        tokenArb.filter((t) => t !== configuredToken),
        (id, wrongToken) =>
          (async () => {
            const body = buildValidSendBody(id)
            const res = await postJson(baseUrl, '/a2a', body, {
              Authorization: `Bearer ${wrongToken}`,
            })

            const resBody = res.body as JsonRpcErrorResponse
            expect(resBody).toHaveProperty('jsonrpc', '2.0')
            expect(resBody).toHaveProperty('error')
            expect(resBody.error.code).toBe(-32001)
            expect(resBody.error.message).toBe('Unauthorized')
          })(),
      ),
      { numRuns: 100 },
    ))

  it('rejects requests with missing Authorization header with error code -32001', () =>
    fc.assert(
      fc.asyncProperty(jsonRpcIdArb, (id) =>
        (async () => {
          const body = buildValidSendBody(id)
          const res = await postJson(baseUrl, '/a2a', body)
          // No Authorization header

          const resBody = res.body as JsonRpcErrorResponse
          expect(resBody).toHaveProperty('jsonrpc', '2.0')
          expect(resBody).toHaveProperty('error')
          expect(resBody.error.code).toBe(-32001)
          expect(resBody.error.message).toBe('Unauthorized')
        })(),
      ),
      { numRuns: 100 },
    ))

  it('rejects requests with malformed Authorization header (not Bearer scheme) with error code -32001', () =>
    fc.assert(
      fc.asyncProperty(
        jsonRpcIdArb,
        fc.constantFrom('Basic', 'Token', 'Digest', 'ApiKey'),
        tokenArb,
        (id, scheme, token) =>
          (async () => {
            const body = buildValidSendBody(id)
            const res = await postJson(baseUrl, '/a2a', body, {
              Authorization: `${scheme} ${token}`,
            })

            const resBody = res.body as JsonRpcErrorResponse
            expect(resBody).toHaveProperty('jsonrpc', '2.0')
            expect(resBody).toHaveProperty('error')
            expect(resBody.error.code).toBe(-32001)
            expect(resBody.error.message).toBe('Unauthorized')
          })(),
      ),
      { numRuns: 100 },
    ))

  it('accepts all requests when A2A_AUTH_TOKEN is not configured', async () => {
    // Create a separate server with no auth token
    const { app: noAuthApp } = createTestServer() // no auth token
    const noAuthServer = await startServer(noAuthApp)

    try {
      await fc.assert(
        fc.asyncProperty(jsonRpcIdArb, (id) =>
          (async () => {
            const body = buildValidSendBody(id)
            // No Authorization header, but server has no token configured
            const res = await postJson(noAuthServer.baseUrl, '/a2a', body)

            const resBody = res.body as Record<string, unknown>
            expect(resBody).toHaveProperty('jsonrpc', '2.0')
            expect(resBody).not.toHaveProperty('error')
            expect(resBody).toHaveProperty('result')
          })(),
        ),
        { numRuns: 100 },
      )
    } finally {
      await noAuthServer.close()
    }
  })
})
