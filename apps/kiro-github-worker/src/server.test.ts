/**
 * Tests for the Express server setup, focusing on A2A route mounting.
 */

import http from 'node:http'

import express from 'express'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { WebhookReceiverResult } from './components/webhook-receiver'
import type { AgentCard } from './lib/a2a-types'
import { createServer } from './server'

// ── Helpers ─────────────────────────────────────────────────────────

/** Creates a minimal mock webhook receiver whose middleware is a no-op pass-through. */
const createMockWebhookReceiver = (): WebhookReceiverResult =>
  ({
    middleware: (_req: unknown, _res: unknown, next?: () => void) => {
      next?.()
      return Promise.resolve()
    },
    webhooks: {} as never,
  }) as unknown as WebhookReceiverResult

/** Silent pino logger. */
const mockLogger = pino({ level: 'silent' })

/** Creates a sample agent card for testing. */
const createSampleAgentCard = (): AgentCard => ({
  name: 'Rocky',
  description: 'Test agent',
  url: '/a2a',
  version: '0.0.0',
  capabilities: { methods: ['tasks/send', 'tasks/get', 'tasks/cancel'] },
  inputSchema: {
    type: 'object',
    properties: {
      repoUrl: { type: 'string', description: 'Repo URL', required: true },
      prompt: { type: 'string', description: 'Task prompt', required: true },
    },
  },
})

/** Start an HTTP server and return the base URL + close function. */
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

// ── Tests ────────────────────────────────────────────────────────────

describe('createServer', () => {
  describe('health check', () => {
    let baseUrl: string
    let closeServer: () => Promise<void>

    beforeAll(async () => {
      const app = createServer({
        webhookReceiver: createMockWebhookReceiver(),
        webhookPath: '/webhook',
        logger: mockLogger,
      })
      const server = await startServer(app)
      baseUrl = server.baseUrl
      closeServer = server.close
    })

    afterAll(async () => {
      await closeServer()
    })

    it('serves health check at /health', async () => {
      const res = await fetch(`${baseUrl}/health`)
      expect(res.status).toBe(200)
      const body: unknown = await res.json()
      expect(body).toEqual({ status: 'ok' })
    })
  })

  describe('A2A disabled (no a2aRouter/agentCard)', () => {
    let baseUrl: string
    let closeServer: () => Promise<void>

    beforeAll(async () => {
      const app = createServer({
        webhookReceiver: createMockWebhookReceiver(),
        webhookPath: '/webhook',
        logger: mockLogger,
      })
      const server = await startServer(app)
      baseUrl = server.baseUrl
      closeServer = server.close
    })

    afterAll(async () => {
      await closeServer()
    })

    it('does not serve agent card at /.well-known/agent.json', async () => {
      const res = await fetch(`${baseUrl}/.well-known/agent.json`)
      expect(res.status).toBe(404)
    })
  })

  describe('A2A enabled (a2aRouter and agentCard provided)', () => {
    let baseUrl: string
    let closeServer: () => Promise<void>
    const agentCard = createSampleAgentCard()

    beforeAll(async () => {
      const a2aRouter = express.Router()
      a2aRouter.use(express.json())
      a2aRouter.post('/a2a', (_req, res) => {
        res.status(200).json({ jsonrpc: '2.0', id: 1, result: 'ok' })
      })

      const app = createServer({
        webhookReceiver: createMockWebhookReceiver(),
        webhookPath: '/webhook',
        logger: mockLogger,
        a2aRouter,
        agentCard,
      })
      const server = await startServer(app)
      baseUrl = server.baseUrl
      closeServer = server.close
    })

    afterAll(async () => {
      await closeServer()
    })

    it('serves agent card at GET /.well-known/agent.json', async () => {
      const res = await fetch(`${baseUrl}/.well-known/agent.json`)
      expect(res.status).toBe(200)
      const body: unknown = await res.json()
      expect(body).toEqual(agentCard)
    })

    it('returns Content-Type application/json for agent card', async () => {
      const res = await fetch(`${baseUrl}/.well-known/agent.json`)
      expect(res.headers.get('content-type')).toMatch(/application\/json/)
    })

    it('serves agent card without requiring authentication', async () => {
      // No Authorization header — should still succeed
      const res = await fetch(`${baseUrl}/.well-known/agent.json`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body['name']).toBe('Rocky')
    })

    it('mounts the A2A router so POST /a2a is reachable', async () => {
      const res = await fetch(`${baseUrl}/a2a`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'test' }),
      })
      expect(res.status).toBe(200)
      const body: unknown = await res.json()
      expect(body).toEqual({ jsonrpc: '2.0', id: 1, result: 'ok' })
    })
  })

  describe('MCP enabled (mcpRouter provided)', () => {
    let baseUrl: string
    let closeServer: () => Promise<void>

    beforeAll(async () => {
      const mcpRouter = express.Router()
      mcpRouter.use(express.json())
      mcpRouter.get('/mcp', (_req, res) => {
        res.status(200).json({ type: 'sse-endpoint' })
      })
      mcpRouter.post('/mcp', (_req, res) => {
        res.status(200).json({ type: 'message-endpoint' })
      })

      const app = createServer({
        webhookReceiver: createMockWebhookReceiver(),
        webhookPath: '/webhook',
        logger: mockLogger,
        mcpRouter,
      })
      const server = await startServer(app)
      baseUrl = server.baseUrl
      closeServer = server.close
    })

    afterAll(async () => {
      await closeServer()
    })

    it('mounts the MCP router so GET /mcp is reachable', async () => {
      const res = await fetch(`${baseUrl}/mcp`)
      expect(res.status).toBe(200)
      const body: unknown = await res.json()
      expect(body).toEqual({ type: 'sse-endpoint' })
    })

    it('mounts the MCP router so POST /mcp is reachable', async () => {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'test' }),
      })
      expect(res.status).toBe(200)
      const body: unknown = await res.json()
      expect(body).toEqual({ type: 'message-endpoint' })
    })
  })

  describe('MCP disabled (no mcpRouter)', () => {
    it('does not serve MCP routes when mcpRouter is not provided', async () => {
      const app = createServer({
        webhookReceiver: createMockWebhookReceiver(),
        webhookPath: '/webhook',
        logger: mockLogger,
      })
      const server = await startServer(app)

      try {
        const res = await fetch(`${server.baseUrl}/mcp`)
        expect(res.status).toBe(404)
      } finally {
        await server.close()
      }
    })
  })

  describe('partial A2A config (only one of a2aRouter/agentCard)', () => {
    it('does not mount routes when only a2aRouter is provided', async () => {
      const a2aRouter = express.Router()
      a2aRouter.post('/a2a', (_req, res) => {
        res.status(200).json({ ok: true })
      })

      const app = createServer({
        webhookReceiver: createMockWebhookReceiver(),
        webhookPath: '/webhook',
        logger: mockLogger,
        a2aRouter,
      })
      const server = await startServer(app)

      try {
        const res = await fetch(`${server.baseUrl}/.well-known/agent.json`)
        expect(res.status).toBe(404)
      } finally {
        await server.close()
      }
    })

    it('does not mount routes when only agentCard is provided', async () => {
      const app = createServer({
        webhookReceiver: createMockWebhookReceiver(),
        webhookPath: '/webhook',
        logger: mockLogger,
        agentCard: createSampleAgentCard(),
      })
      const server = await startServer(app)

      try {
        const res = await fetch(`${server.baseUrl}/.well-known/agent.json`)
        expect(res.status).toBe(404)
      } finally {
        await server.close()
      }
    })
  })
})
