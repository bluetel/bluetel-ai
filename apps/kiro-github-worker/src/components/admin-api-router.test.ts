/**
 * Unit tests for admin-api-router.ts — task list, task detail, and
 * isValidLogFilename helper (task 3.1).
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */

import http from 'node:http'

import express from 'express'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { A2ATask, A2ATaskStore } from '../lib/a2a-types'
import type { MCPTask, MCPTaskStore } from '../lib/mcp-types'

import { createAdminApiRouter, isValidLogFilename } from './admin-api-router'
import type { AdminApiDependencies, AdminApiRouterOptions } from './admin-api-router'
import { parseTaskInput } from './mcp-task-handler'

// ── Helpers ─────────────────────────────────────────────────────────

const logger = pino({ level: 'silent' })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

/** Fetch JSON from a URL and return status + parsed body. */
const fetchJson = async (url: string): Promise<{ status: number; body: Json }> => {
  const res = await fetch(url)
  const body = await res.json()
  return { status: res.status, body }
}

const buildA2ATask = (overrides: Partial<A2ATask> = {}): A2ATask => ({
  id: crypto.randomUUID(),
  status: 'completed',
  input: {
    repoUrl: 'https://github.com/owner/repo',
    baseBranch: 'main',
    prompt: 'Do something',
  },
  repoFullName: 'owner/repo',
  queueKey: 'owner/repo:a2a-123',
  artifacts: [],
  promptSummary: null,
  resultSummary: null,
  createdAt: new Date('2024-01-01T00:00:00Z'),
  updatedAt: new Date('2024-01-01T01:00:00Z'),
  completedAt: new Date('2024-01-01T01:00:00Z'),
  ...overrides,
})

const buildMCPTask = (overrides: Partial<MCPTask> = {}): MCPTask => ({
  id: crypto.randomUUID(),
  status: 'working',
  input: {
    repoUrl: 'https://github.com/owner/repo2',
    baseBranch: 'develop',
    prompt: 'Fix bug',
  },
  repoFullName: 'owner/repo2',
  queueKey: 'owner/repo2:mcp-456',
  artifacts: [],
  promptSummary: null,
  resultSummary: null,
  createdAt: new Date('2024-01-02T00:00:00Z'),
  updatedAt: new Date('2024-01-02T02:00:00Z'),
  completedAt: null,
  ...overrides,
})

const createMockA2AStore = (tasks: A2ATask[] = []): A2ATaskStore => {
  const map = new Map(tasks.map((t) => [t.id, t]))
  return {
    create: () => tasks[0] ?? buildA2ATask(),
    get: (id) => map.get(id),
    getAll: () => [...map.values()],
    updateStatus: () => {},
    setError: () => {},
    addArtifact: () => {},
    setCompleted: () => {},
    setPromptSummary: () => {},
    setResultSummary: () => {},
  }
}

const createMockMCPStore = (tasks: MCPTask[] = []): MCPTaskStore => {
  const map = new Map(tasks.map((t) => [t.id, t]))
  return {
    create: () => tasks[0] ?? buildMCPTask(),
    get: (id) => map.get(id),
    getAll: () => [...map.values()],
    updateStatus: () => {},
    setError: () => {},
    addArtifact: () => {},
    setCompleted: () => {},
    setPromptSummary: () => {},
    setResultSummary: () => {},
  }
}

const createTestApp = (a2aTasks: A2ATask[] = [], mcpTasks: MCPTask[] = []): express.Express => {
  const options: AdminApiRouterOptions = {}
  const deps: AdminApiDependencies = {
    a2aTaskStore: createMockA2AStore(a2aTasks),
    mcpTaskStore: createMockMCPStore(mcpTasks),
    jobQueue: {
      enqueue: () => ({}) as never,
      getQueuePosition: () => 0,
      getJob: () => undefined,
      getAllJobs: () => [],
    },
    sessionLogDir: '/tmp/logs',
    logger,
    startedAt: new Date(),
    mcpTaskHandler: {
      parseTaskInput: () => ({}) as never,
      executeTask: async () => {},
      cancelTask: () => Promise.resolve(false),
    },
    config: {} as never,
    authResult: {} as never,
  }

  const app = express()
  app.use(createAdminApiRouter(options, deps))
  return app
}

/** Start an HTTP server on a random port and return the base URL + close function. */
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
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })

// ── isValidLogFilename ──────────────────────────────────────────────

describe('isValidLogFilename', () => {
  it('rejects empty strings', () => {
    expect(isValidLogFilename('')).toBe(false)
  })

  it('rejects filenames containing ".."', () => {
    expect(isValidLogFilename('../etc/passwd')).toBe(false)
    expect(isValidLogFilename('foo..bar')).toBe(false)
  })

  it('rejects filenames containing "/"', () => {
    expect(isValidLogFilename('path/to/file')).toBe(false)
  })

  it('rejects filenames containing "\\"', () => {
    expect(isValidLogFilename('path\\to\\file')).toBe(false)
  })

  it('accepts valid filenames', () => {
    expect(isValidLogFilename('session-2024-01-01.log')).toBe(true)
    expect(isValidLogFilename('task_abc123.log')).toBe(true)
    expect(isValidLogFilename('a')).toBe(true)
  })
})

// ── GET /api/tasks ────────────────────────────────────────────

describe('GET /api/tasks', () => {
  let baseUrl: string
  let closeServer: () => Promise<void>

  describe('with empty stores', () => {
    beforeAll(async () => {
      const app = createTestApp()
      const server = await startServer(app)
      baseUrl = server.baseUrl
      closeServer = server.close
    })

    afterAll(async () => {
      await closeServer()
    })

    it('returns empty list when no tasks exist', async () => {
      const { status, body } = await fetchJson(`${baseUrl}/api/tasks`)

      expect(status).toBe(200)
      expect(body.items).toEqual([])
      expect(body.total).toBe(0)
      expect(body.page).toBe(1)
      expect(body.pageSize).toBe(50)
      expect(body.totalPages).toBe(0)
    })
  })

  describe('with tasks in stores', () => {
    const a2aTask = buildA2ATask({ updatedAt: new Date('2024-01-01T01:00:00Z') })
    const mcpTask = buildMCPTask({ updatedAt: new Date('2024-01-02T02:00:00Z') })

    beforeAll(async () => {
      const app = createTestApp([a2aTask], [mcpTask])
      const server = await startServer(app)
      baseUrl = server.baseUrl
      closeServer = server.close
    })

    afterAll(async () => {
      await closeServer()
    })

    it('merges tasks from both stores and sorts by updatedAt desc', async () => {
      const { status, body } = await fetchJson(`${baseUrl}/api/tasks`)

      expect(status).toBe(200)
      expect(body.items).toHaveLength(2)
      // MCP task has later updatedAt, should be first
      expect(body.items[0].id).toBe(mcpTask.id)
      expect(body.items[1].id).toBe(a2aTask.id)
    })

    it('serializes A2A tasks with protocol "a2a"', async () => {
      const { body } = await fetchJson(`${baseUrl}/api/tasks`)

      const a2aItem = body.items.find((t: { id: string }) => t.id === a2aTask.id)
      expect(a2aItem.protocol).toBe('a2a')
    })

    it('serializes MCP tasks with protocol "mcp"', async () => {
      const { body } = await fetchJson(`${baseUrl}/api/tasks`)

      const mcpItem = body.items.find((t: { id: string }) => t.id === mcpTask.id)
      expect(mcpItem.protocol).toBe('mcp')
    })
  })

  describe('pagination', () => {
    const tasks = Array.from({ length: 3 }, (_, i) =>
      buildA2ATask({ updatedAt: new Date(`2024-01-0${3 - i}T00:00:00Z`) }),
    )

    beforeAll(async () => {
      const app = createTestApp(tasks)
      const server = await startServer(app)
      baseUrl = server.baseUrl
      closeServer = server.close
    })

    afterAll(async () => {
      await closeServer()
    })

    it('paginates with custom pageSize', async () => {
      const { status, body } = await fetchJson(`${baseUrl}/api/tasks?page=1&pageSize=2`)

      expect(status).toBe(200)
      expect(body.items).toHaveLength(2)
      expect(body.total).toBe(3)
      expect(body.page).toBe(1)
      expect(body.pageSize).toBe(2)
      expect(body.totalPages).toBe(2)
    })

    it('returns second page correctly', async () => {
      const { status, body } = await fetchJson(`${baseUrl}/api/tasks?page=2&pageSize=2`)

      expect(status).toBe(200)
      expect(body.items).toHaveLength(1)
      expect(body.page).toBe(2)
    })
  })

  describe('manual task classification', () => {
    const manualTask = buildMCPTask({ queueKey: 'owner/repo:manual-abc' })

    beforeAll(async () => {
      const app = createTestApp([], [manualTask])
      const server = await startServer(app)
      baseUrl = server.baseUrl
      closeServer = server.close
    })

    afterAll(async () => {
      await closeServer()
    })

    it('serializes manual tasks with protocol "manual"', async () => {
      const { body } = await fetchJson(`${baseUrl}/api/tasks`)

      expect(body.items[0].protocol).toBe('manual')
    })
  })

  describe('error details', () => {
    const taskWithError = buildA2ATask({
      error: { step: 'clone', message: 'Failed to clone' },
    })
    const taskWithoutError = buildA2ATask()

    beforeAll(async () => {
      delete taskWithoutError.error
      const app = createTestApp([taskWithError, taskWithoutError])
      const server = await startServer(app)
      baseUrl = server.baseUrl
      closeServer = server.close
    })

    afterAll(async () => {
      await closeServer()
    })

    it('includes error details when present', async () => {
      const { body } = await fetchJson(`${baseUrl}/api/tasks`)

      const item = body.items.find((t: { id: string }) => t.id === taskWithError.id)
      expect(item.error).toEqual({ step: 'clone', message: 'Failed to clone' })
    })

    it('omits error field when not present', async () => {
      const { body } = await fetchJson(`${baseUrl}/api/tasks`)

      const item = body.items.find((t: { id: string }) => t.id === taskWithoutError.id)
      expect(item.error).toBeUndefined()
    })
  })
})

// ── GET /api/tasks/:id ────────────────────────────────────────

describe('GET /api/tasks/:id', () => {
  const a2aTask = buildA2ATask()
  const mcpTask = buildMCPTask({
    input: {
      repoUrl: 'https://github.com/test/repo',
      baseBranch: 'main',
      prompt: 'Test prompt',
      installScript: 'npm install',
      engine: 'kiro',
    },
    artifacts: [{ type: 'stdout', value: 'output' }],
    error: { step: 'kiro-cli', message: 'timeout' },
  })

  let baseUrl: string
  let closeServer: () => Promise<void>

  beforeAll(async () => {
    const app = createTestApp([a2aTask], [mcpTask])
    const server = await startServer(app)
    baseUrl = server.baseUrl
    closeServer = server.close
  })

  afterAll(async () => {
    await closeServer()
  })

  it('returns A2A task by ID', async () => {
    const { status, body } = await fetchJson(`${baseUrl}/api/tasks/${a2aTask.id}`)

    expect(status).toBe(200)
    expect(body.id).toBe(a2aTask.id)
    expect(body.protocol).toBe('a2a')
  })

  it('returns MCP task by ID', async () => {
    const { status, body } = await fetchJson(`${baseUrl}/api/tasks/${mcpTask.id}`)

    expect(status).toBe(200)
    expect(body.id).toBe(mcpTask.id)
    expect(body.protocol).toBe('mcp')
  })

  it('returns 404 for non-existent task ID', async () => {
    const { status, body } = await fetchJson(`${baseUrl}/api/tasks/non-existent-id`)

    expect(status).toBe(404)
    expect(body).toEqual({ error: 'Task not found' })
  })

  it('includes all task fields in detail response', async () => {
    const { status, body } = await fetchJson(`${baseUrl}/api/tasks/${mcpTask.id}`)

    expect(status).toBe(200)
    expect(body.input.installScript).toBe('npm install')
    expect(body.input.engine).toBe('kiro')
    expect(body.artifacts).toEqual([{ type: 'stdout', value: 'output' }])
    expect(body.error).toEqual({ step: 'kiro-cli', message: 'timeout' })
    expect(body.createdAt).toBe(mcpTask.createdAt.toISOString())
    expect(body.updatedAt).toBe(mcpTask.updatedAt.toISOString())
    expect(body.completedAt).toBeNull()
  })
})

// ── GET /api/summary ──────────────────────────────────────────

describe('GET /api/summary', () => {
  describe('with empty stores and no active jobs', () => {
    let baseUrl: string
    let closeServer: () => Promise<void>

    beforeAll(async () => {
      const app = createTestApp()
      const server = await startServer(app)
      baseUrl = server.baseUrl
      closeServer = server.close
    })

    afterAll(async () => {
      await closeServer()
    })

    it('returns healthy status', async () => {
      const { status, body } = await fetchJson(`${baseUrl}/api/summary`)

      expect(status).toBe(200)
      expect(body.health).toBe('healthy')
    })

    it('returns uptime with days, hours, minutes', async () => {
      const { body } = await fetchJson(`${baseUrl}/api/summary`)

      expect(body.uptime).toHaveProperty('days')
      expect(body.uptime).toHaveProperty('hours')
      expect(body.uptime).toHaveProperty('minutes')
      expect(typeof body.uptime.days).toBe('number')
      expect(typeof body.uptime.hours).toBe('number')
      expect(typeof body.uptime.minutes).toBe('number')
    })

    it('returns zero task counts when stores are empty', async () => {
      const { body } = await fetchJson(`${baseUrl}/api/summary`)

      expect(body.taskCounts.total).toEqual({
        submitted: 0,
        working: 0,
        completed: 0,
        failed: 0,
        canceled: 0,
      })
      expect(body.taskCounts.manual).toEqual({
        submitted: 0,
        working: 0,
        completed: 0,
        failed: 0,
        canceled: 0,
      })
    })

    it('returns zero active queue count when no active jobs', async () => {
      const { body } = await fetchJson(`${baseUrl}/api/summary`)

      expect(body.activeQueueCount).toBe(0)
    })
  })

  describe('with tasks and active jobs', () => {
    let baseUrl: string
    let closeServer: () => Promise<void>

    const a2aTasks = [buildA2ATask({ status: 'completed' }), buildA2ATask({ status: 'working' })]
    const mcpTasks = [
      buildMCPTask({ status: 'failed' }),
      buildMCPTask({ status: 'working', queueKey: 'owner/repo:manual-abc' }),
    ]

    const mockJobs: Array<{
      id: string
      queueKey: string
      status: string
      enqueuedAt: Date
      startedAt: Date | null
      completedAt: Date | null
      error: string | null
      event: unknown
    }> = [
      {
        id: '1',
        queueKey: 'owner/repo:1',
        status: 'in-progress',
        enqueuedAt: new Date(),
        startedAt: new Date(),
        completedAt: null,
        error: null,
        event: {},
      },
      {
        id: '2',
        queueKey: 'owner/repo:2',
        status: 'queued',
        enqueuedAt: new Date(),
        startedAt: null,
        completedAt: null,
        error: null,
        event: {},
      },
      {
        id: '3',
        queueKey: 'owner/repo:1',
        status: 'completed',
        enqueuedAt: new Date(),
        startedAt: new Date(),
        completedAt: new Date(),
        error: null,
        event: {},
      },
    ]

    beforeAll(async () => {
      const options: AdminApiRouterOptions = {}
      const deps: AdminApiDependencies = {
        a2aTaskStore: createMockA2AStore(a2aTasks),
        mcpTaskStore: createMockMCPStore(mcpTasks),
        jobQueue: {
          enqueue: () => ({}) as never,
          getQueuePosition: () => 0,
          getJob: () => undefined,
          getAllJobs: () => mockJobs as never,
        },
        sessionLogDir: '/tmp/logs',
        logger,
        startedAt: new Date(Date.now() - 90 * 60_000), // 90 minutes ago
        mcpTaskHandler: {
          parseTaskInput: () => ({}) as never,
          executeTask: async () => {},
          cancelTask: () => Promise.resolve(false),
        },
        config: {} as never,
        authResult: {} as never,
      }

      const app = express()
      app.use(createAdminApiRouter(options, deps))
      const server = await startServer(app)
      baseUrl = server.baseUrl
      closeServer = server.close
    })

    afterAll(async () => {
      await closeServer()
    })

    it('aggregates task counts from both stores', async () => {
      const { body } = await fetchJson(`${baseUrl}/api/summary`)

      // 1 A2A completed + 1 webhook job completed = 2
      expect(body.taskCounts.total.completed).toBe(2)
      // 1 A2A working + 1 MCP working + 1 webhook job in-progress = 3
      expect(body.taskCounts.total.working).toBe(3)
      expect(body.taskCounts.total.failed).toBe(1)
      // 1 webhook job queued = 1
      expect(body.taskCounts.total.submitted).toBe(1)
    })

    it('counts manual tasks separately', async () => {
      const { body } = await fetchJson(`${baseUrl}/api/summary`)

      expect(body.taskCounts.manual.working).toBe(1)
      expect(body.taskCounts.manual.completed).toBe(0)
    })

    it('counts active queue keys correctly', async () => {
      const { body } = await fetchJson(`${baseUrl}/api/summary`)

      // Two queue keys have active jobs: owner/repo:1 (in-progress) and owner/repo:2 (queued)
      expect(body.activeQueueCount).toBe(2)
    })

    it('computes uptime correctly', async () => {
      const { body } = await fetchJson(`${baseUrl}/api/summary`)

      // Started 90 minutes ago → 0 days, 1 hour, 30 minutes
      expect(body.uptime.days).toBe(0)
      expect(body.uptime.hours).toBe(1)
      expect(body.uptime.minutes).toBe(30)
    })
  })
})

// ── POST /api/tasks ───────────────────────────────────────────

describe('POST /api/tasks', () => {
  let baseUrl: string
  let closeServer: () => Promise<void>
  let enqueueJobCalls: Array<{ queueKey: string }>

  beforeAll(async () => {
    enqueueJobCalls = []

    const createdTask: MCPTask = {
      id: 'new-task-id',
      status: 'submitted',
      input: {
        repoUrl: 'https://github.com/owner/repo',
        baseBranch: 'main',
        prompt: 'Do something',
      },
      repoFullName: 'owner/repo',
      queueKey: 'owner/repo:mcp-new-task-id',
      artifacts: [],
      promptSummary: null,
      resultSummary: null,
      createdAt: new Date('2024-06-01T00:00:00Z'),
      updatedAt: new Date('2024-06-01T00:00:00Z'),
      completedAt: null,
    }

    let lastCreatedTask: MCPTask = createdTask

    const mockMCPStore: MCPTaskStore = {
      create: () => {
        // Return a fresh task each time to avoid cross-test mutation
        lastCreatedTask = { ...createdTask, status: 'submitted' }
        return lastCreatedTask
      },
      get: (id) => (id === createdTask.id ? lastCreatedTask : undefined),
      getAll: () => [lastCreatedTask],
      updateStatus: (_id, status) => {
        lastCreatedTask.status = status
      },
      setError: () => {},
      addArtifact: () => {},
      setCompleted: () => {},
      setPromptSummary: () => {},
      setResultSummary: () => {},
    }

    const options: AdminApiRouterOptions = {}
    const deps: AdminApiDependencies = {
      a2aTaskStore: createMockA2AStore([]),
      mcpTaskStore: mockMCPStore,
      jobQueue: {
        enqueue: () => ({}) as never,
        getQueuePosition: () => 0,
        getJob: () => undefined,
        getAllJobs: () => [],
      },
      sessionLogDir: '/tmp/logs',
      logger,
      startedAt: new Date(),
      mcpTaskHandler: {
        parseTaskInput: (args: Record<string, unknown>) => parseTaskInput(args),
        executeTask: async () => {},
        cancelTask: () => Promise.resolve(false),
      },
      config: {} as never,
      authResult: {} as never,
      enqueueJob: (queueKey: string) => {
        enqueueJobCalls.push({ queueKey })
      },
    }

    const app = express()
    app.use(createAdminApiRouter(options, deps))
    const server = await startServer(app)
    baseUrl = server.baseUrl
    closeServer = server.close
  })

  afterAll(async () => {
    await closeServer()
  })

  it('returns 400 when repoUrl is missing', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseBranch: 'main', prompt: 'test' }),
    })
    const body: Json = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe('Validation failed')
    expect(body.details.field).toBe('repoUrl')
  })

  it('returns 400 when repoUrl is invalid', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoUrl: 'https://gitlab.com/owner/repo',
        baseBranch: 'main',
        prompt: 'test',
      }),
    })
    const body: Json = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe('Validation failed')
    expect(body.details.field).toBe('repoUrl')
  })

  it('returns 400 when baseBranch is empty', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoUrl: 'https://github.com/owner/repo',
        baseBranch: '',
        prompt: 'test',
      }),
    })
    const body: Json = await res.json()

    expect(res.status).toBe(400)
    expect(body.details.field).toBe('baseBranch')
  })

  it('returns 400 when baseBranch has invalid characters', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoUrl: 'https://github.com/owner/repo',
        baseBranch: 'main branch',
        prompt: 'test',
      }),
    })
    const body: Json = await res.json()

    expect(res.status).toBe(400)
    expect(body.details.field).toBe('baseBranch')
  })

  it('returns 400 when prompt is empty', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoUrl: 'https://github.com/owner/repo',
        baseBranch: 'main',
        prompt: '',
      }),
    })
    const body: Json = await res.json()

    expect(res.status).toBe(400)
    expect(body.details.field).toBe('prompt')
  })

  it('returns 400 when engine is invalid', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoUrl: 'https://github.com/owner/repo',
        baseBranch: 'main',
        prompt: 'test',
        engine: 'invalid',
      }),
    })
    const body: Json = await res.json()

    expect(res.status).toBe(400)
    expect(body.details.field).toBe('engine')
  })

  it('returns 201 with created task on valid input', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoUrl: 'https://github.com/owner/repo',
        baseBranch: 'main',
        prompt: 'Do something',
      }),
    })
    const body: Json = await res.json()

    expect(res.status).toBe(201)
    expect(body.id).toBe('new-task-id')
    expect(body.protocol).toBe('manual')
    expect(body.status).toBe('working')
    expect(body.repoFullName).toBe('owner/repo')
    expect(body.queueKey).toContain(':manual-')
  })

  it('enqueues a job with the manual queue key', async () => {
    enqueueJobCalls.length = 0

    await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoUrl: 'https://github.com/owner/repo',
        baseBranch: 'main',
        prompt: 'Do something',
      }),
    })

    expect(enqueueJobCalls.length).toBe(1)
    expect(enqueueJobCalls[0].queueKey).toContain(':manual-')
  })

  it('accepts optional installScript and engine fields', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoUrl: 'https://github.com/owner/repo',
        baseBranch: 'main',
        prompt: 'Do something',
        installScript: 'npm install',
        engine: 'copilot',
      }),
    })

    expect(res.status).toBe(201)
  })

  it('accepts repoUrl with .git suffix', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoUrl: 'https://github.com/owner/repo.git',
        baseBranch: 'main',
        prompt: 'Do something',
      }),
    })

    expect(res.status).toBe(201)
  })
})

// ── Agent endpoint tests ────────────────────────────────────────────

describe('GET /api/agents and POST /api/agents/refresh', () => {
  let baseUrl: string
  let close: () => Promise<void>

  beforeAll(async () => {
    const mockAgentRegistry = {
      getAgents: () => [
        {
          name: 'kiro_default',
          scope: 'builtin' as const,
          description: 'Default agent',
          isDefault: true,
        },
        {
          name: 'spec-agent',
          scope: 'global' as const,
          description: 'Spec agent',
          isDefault: false,
        },
      ],
      getAgent: (name: string) => {
        const agents = [
          {
            name: 'kiro_default',
            scope: 'builtin' as const,
            description: 'Default agent',
            isDefault: true,
          },
          {
            name: 'spec-agent',
            scope: 'global' as const,
            description: 'Spec agent',
            isDefault: false,
          },
        ]
        return agents.find((a) => a.name === name)
      },
      refresh: () =>
        Promise.resolve([
          {
            name: 'kiro_default',
            scope: 'builtin' as const,
            description: 'Default agent',
            isDefault: true,
          },
          {
            name: 'spec-agent',
            scope: 'global' as const,
            description: 'Spec agent',
            isDefault: false,
          },
          { name: 'new-agent', scope: 'workspace' as const, description: 'New', isDefault: false },
        ]),
      getState: () => ({
        agents: [
          {
            name: 'kiro_default',
            scope: 'builtin' as const,
            description: 'Default agent',
            isDefault: true,
          },
          {
            name: 'spec-agent',
            scope: 'global' as const,
            description: 'Spec agent',
            isDefault: false,
          },
        ],
        discoveredAt: '2024-01-01T00:00:00.000Z',
      }),
    }

    const options: AdminApiRouterOptions = {}
    const deps: AdminApiDependencies = {
      a2aTaskStore: createMockA2AStore(),
      mcpTaskStore: createMockMCPStore(),
      jobQueue: {
        enqueue: () => ({}) as never,
        getQueuePosition: () => 0,
        getJob: () => undefined,
        getAllJobs: () => [],
      },
      sessionLogDir: '/tmp/logs',
      logger,
      startedAt: new Date(),
      mcpTaskHandler: {
        parseTaskInput: () => ({}) as never,
        executeTask: async () => {},
        cancelTask: () => Promise.resolve(false),
      },
      config: {} as never,
      authResult: {} as never,
      agentRegistry: mockAgentRegistry,
    }

    const app = express()
    app.use(createAdminApiRouter(options, deps))
    const result = await startServer(app)
    baseUrl = result.baseUrl
    close = result.close
  })

  afterAll(async () => {
    await close()
  })

  it('GET /api/agents returns cached agent list', async () => {
    const { status, body } = await fetchJson(`${baseUrl}/api/agents`)

    expect(status).toBe(200)
    expect(body.agents).toHaveLength(2)
    expect(body.agents[0].name).toBe('kiro_default')
    expect(body.agents[0].isDefault).toBe(true)
    expect(body.discoveredAt).toBe('2024-01-01T00:00:00.000Z')
  })

  it('POST /api/agents/refresh triggers re-discovery', async () => {
    const res = await fetch(`${baseUrl}/api/agents/refresh`, { method: 'POST' })
    const body: Json = await res.json()

    expect(res.status).toBe(200)
    expect(body.agents).toHaveLength(3)
    expect(body.agents[2].name).toBe('new-agent')
  })
})

describe('GET /api/agents with no agent registry', () => {
  let baseUrl: string
  let close: () => Promise<void>

  beforeAll(async () => {
    const options: AdminApiRouterOptions = {}
    const deps: AdminApiDependencies = {
      a2aTaskStore: createMockA2AStore(),
      mcpTaskStore: createMockMCPStore(),
      jobQueue: {
        enqueue: () => ({}) as never,
        getQueuePosition: () => 0,
        getJob: () => undefined,
        getAllJobs: () => [],
      },
      sessionLogDir: '/tmp/logs',
      logger,
      startedAt: new Date(),
      mcpTaskHandler: {
        parseTaskInput: () => ({}) as never,
        executeTask: async () => {},
        cancelTask: () => Promise.resolve(false),
      },
      config: {} as never,
      authResult: {} as never,
      // agentRegistry intentionally omitted
    }

    const app = express()
    app.use(createAdminApiRouter(options, deps))
    const result = await startServer(app)
    baseUrl = result.baseUrl
    close = result.close
  })

  afterAll(async () => {
    await close()
  })

  it('returns empty agents list when registry is not configured', async () => {
    const { status, body } = await fetchJson(`${baseUrl}/api/agents`)

    expect(status).toBe(200)
    expect(body.agents).toEqual([])
    expect(body.discoveredAt).toBeNull()
  })
})
