/**
 * Admin API router for the worker dashboard.
 *
 * Exposes endpoints for listing/viewing tasks, queue state, session logs,
 * health summary, and manual task creation. Mounted at `/api` on
 * the existing Express app.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import express, { Router } from 'express'
import type pino from 'pino'

import type { A2ATask, A2ATaskHandler, A2ATaskStore } from '../lib/a2a-types'
import type { MCPTask, MCPTaskHandler, MCPTaskStore } from '../lib/mcp-types'
import type { AuthResult, Engine, Job, WorkerConfig } from '../lib/types'

import type { AgentRegistry } from './agent-registry'
import type { JobQueueInstance } from './job-queue'
import { extractRepoFullName, isValidationError } from './mcp-task-handler'

// ── Types ───────────────────────────────────────────────────────────

export interface AdminApiRouterOptions {
  adminApiToken?: string
}

export interface AdminApiDependencies {
  a2aTaskStore: A2ATaskStore
  mcpTaskStore: MCPTaskStore
  jobQueue: JobQueueInstance
  sessionLogDir: string
  logger: pino.Logger
  startedAt: Date
  mcpTaskHandler: MCPTaskHandler
  a2aTaskHandler?: A2ATaskHandler
  config: WorkerConfig
  authResult: AuthResult
  agentRegistry?: AgentRegistry
  enqueueJob?: (queueKey: string, jobFn: () => Promise<void>) => void
}

export interface UnifiedTask {
  id: string
  protocol: 'a2a' | 'mcp' | 'manual' | 'webhook'
  status: string
  repoFullName: string
  queueKey: string
  input: {
    repoUrl: string
    baseBranch: string
    prompt: string
    installScript?: string
    engine?: Engine
    agent?: string
  }
  artifacts: Array<{ type: string; value: string }>
  error?: { step: string; message: string }
  promptSummary: string | null
  resultSummary: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Strips ANSI escape sequences from a string. */
const stripAnsi = (str: string): string =>
  // eslint-disable-next-line no-control-regex
  str.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)/g, '')

/**
 * Validates a session log filename, rejecting path traversal attempts
 * and empty strings.
 *
 * Rejects filenames containing `..`, `/`, `\`, or that are empty.
 */
export const isValidLogFilename = (filename: string): boolean => {
  if (filename.length === 0) return false
  if (filename.includes('..')) return false
  if (filename.includes('/')) return false
  if (filename.includes('\\')) return false
  return true
}

/**
 * Serializes an A2A task into the unified task format.
 */
const serializeA2ATask = (task: A2ATask): UnifiedTask => ({
  id: task.id,
  protocol: 'a2a',
  status: task.status,
  repoFullName: task.repoFullName,
  queueKey: task.queueKey,
  input: {
    repoUrl: task.input.repoUrl,
    baseBranch: task.input.baseBranch,
    prompt: stripAnsi(task.input.prompt),
    ...(task.input.installScript != null ? { installScript: task.input.installScript } : {}),
    ...(task.input.engine != null ? { engine: task.input.engine } : {}),
    ...(task.input.agent != null ? { agent: task.input.agent } : {}),
  },
  artifacts: task.artifacts.map((a) => ({ type: a.type, value: stripAnsi(a.value) })),
  ...(task.error != null
    ? { error: { step: task.error.step, message: stripAnsi(task.error.message) } }
    : {}),
  promptSummary: task.promptSummary,
  resultSummary: task.resultSummary,
  createdAt: task.createdAt.toISOString(),
  updatedAt: task.updatedAt.toISOString(),
  completedAt: task.completedAt != null ? task.completedAt.toISOString() : null,
})

/**
 * Serializes an MCP task into the unified task format.
 * Tasks with a queue key containing `:manual-` are classified as 'manual'.
 */
const serializeMCPTask = (task: MCPTask): UnifiedTask => ({
  id: task.id,
  protocol: task.queueKey.includes(':manual-') ? 'manual' : 'mcp',
  status: task.status,
  repoFullName: task.repoFullName,
  queueKey: task.queueKey,
  input: {
    repoUrl: task.input.repoUrl,
    baseBranch: task.input.baseBranch,
    prompt: stripAnsi(task.input.prompt),
    ...(task.input.installScript != null ? { installScript: task.input.installScript } : {}),
    ...(task.input.engine != null ? { engine: task.input.engine } : {}),
    ...(task.input.agent != null ? { agent: task.input.agent } : {}),
  },
  artifacts: task.artifacts.map((a) => ({ type: a.type, value: stripAnsi(a.value) })),
  ...(task.error != null
    ? { error: { step: task.error.step, message: stripAnsi(task.error.message) } }
    : {}),
  promptSummary: task.promptSummary,
  resultSummary: task.resultSummary,
  createdAt: task.createdAt.toISOString(),
  updatedAt: task.updatedAt.toISOString(),
  completedAt: task.completedAt != null ? task.completedAt.toISOString() : null,
})

/**
 * Maps a webhook job status to the unified task status.
 */
const mapJobStatus = (status: Job['status']): string => {
  switch (status) {
    case 'queued':
      return 'submitted'
    case 'in-progress':
      return 'working'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
  }
}

/**
 * Extracts a human-readable prompt summary from a webhook job's event.
 */
const getWebhookPromptSummary = (event: Job['event']): string => {
  switch (event.type) {
    case 'new_issue':
      return `Issue #${String(event.issueNumber)}: ${event.issueTitle}`
    case 'follow_up_comment':
      return `Follow-up on #${String(event.issueNumber)}: ${event.issueTitle}`
    case 'pr_review_comment':
      return `PR #${String(event.prNumber)} review comment`
    case 'pr_review_changes_requested':
      return `PR #${String(event.prNumber)} changes requested`
    case 'pr_comment':
      return `PR #${String(event.prNumber)} comment`
  }
}

/**
 * Extracts the prompt body text from a webhook job's event.
 */
const getWebhookPromptBody = (event: Job['event']): string => {
  switch (event.type) {
    case 'new_issue':
      return event.issueBody
    case 'follow_up_comment':
      return event.commentBody
    case 'pr_review_comment':
      return event.commentBody
    case 'pr_review_changes_requested':
      return event.reviewBody
    case 'pr_comment':
      return event.commentBody
  }
}

/**
 * Serializes a webhook Job into the unified task format.
 */
const serializeWebhookJob = (job: Job): UnifiedTask => ({
  id: job.id,
  protocol: 'webhook',
  status: mapJobStatus(job.status),
  repoFullName: job.event.repo,
  queueKey: job.queueKey,
  input: {
    repoUrl: `https://github.com/${job.event.repo}`,
    baseBranch: 'main',
    prompt: getWebhookPromptBody(job.event),
  },
  artifacts: [],
  ...(job.error != null ? { error: { step: 'processing', message: job.error } } : {}),
  promptSummary: getWebhookPromptSummary(job.event),
  resultSummary: null,
  createdAt: job.enqueuedAt.toISOString(),
  updatedAt: (job.completedAt ?? job.startedAt ?? job.enqueuedAt).toISOString(),
  completedAt: job.completedAt != null ? job.completedAt.toISOString() : null,
})

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Creates an Express router with admin API endpoints for tasks, queue,
 * logs, and health summary.
 */
export const createAdminApiRouter = (
  _options: AdminApiRouterOptions,
  deps: AdminApiDependencies,
): Router => {
  const router = Router()
  const { a2aTaskStore, mcpTaskStore } = deps

  // ── GET /api/tasks ────────────────────────────────────────

  router.get('/api/tasks', (req, res) => {
    try {
      // Merge tasks from both stores and webhook jobs
      const a2aTasks = a2aTaskStore.getAll().map(serializeA2ATask)
      const mcpTasks = mcpTaskStore.getAll().map(serializeMCPTask)
      const webhookTasks = deps.jobQueue.getAllJobs().map(serializeWebhookJob)
      const allTasks = [...a2aTasks, ...mcpTasks, ...webhookTasks]

      // Sort by updatedAt descending
      allTasks.sort((a, b) => {
        const dateA = new Date(a.updatedAt).getTime()
        const dateB = new Date(b.updatedAt).getTime()
        return dateB - dateA
      })

      // Paginate
      const page = Math.max(1, parseInt(req.query['page'] as string, 10) || 1)
      const pageSize = Math.max(1, parseInt(req.query['pageSize'] as string, 10) || 50)
      const total = allTasks.length
      const totalPages = Math.ceil(total / pageSize)
      const startIndex = (page - 1) * pageSize
      const items = allTasks.slice(startIndex, startIndex + pageSize)

      res.json({
        items,
        total,
        page,
        pageSize,
        totalPages,
      })
    } catch {
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ── GET /api/tasks/:id ────────────────────────────────────

  router.get('/api/tasks/:id', (req, res) => {
    try {
      const { id } = req.params

      // Look up in A2A store first
      const a2aTask = a2aTaskStore.get(id)
      if (a2aTask != null) {
        res.json(serializeA2ATask(a2aTask))
        return
      }

      // Look up in MCP store
      const mcpTask = mcpTaskStore.get(id)
      if (mcpTask != null) {
        res.json(serializeMCPTask(mcpTask))
        return
      }

      // Look up in webhook job queue
      const webhookJob = deps.jobQueue.getJob(id)
      if (webhookJob != null) {
        res.json(serializeWebhookJob(webhookJob))
        return
      }

      // Not found in any store
      res.status(404).json({ error: 'Task not found' })
    } catch {
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ── GET /api/queue ──────────────────────────────────────────

  router.get('/api/queue', (_req, res) => {
    try {
      const allJobs = deps.jobQueue.getAllJobs()

      // Group jobs by queue key
      const groupedByKey = new Map<string, Job[]>()
      for (const job of allJobs) {
        let jobs = groupedByKey.get(job.queueKey)
        if (jobs == null) {
          jobs = []
          groupedByKey.set(job.queueKey, jobs)
        }
        jobs.push(job)
      }

      // Sort queue keys alphabetically
      const sortedKeys = [...groupedByKey.keys()].sort()

      // Build queues array
      const queues = sortedKeys.map((queueKey) => {
        const jobs = groupedByKey.get(queueKey) ?? []

        // Sort jobs by enqueuedAt ascending
        jobs.sort((a, b) => a.enqueuedAt.getTime() - b.enqueuedAt.getTime())

        // Count jobs by status
        const counts: Record<string, number> = {}
        for (const job of jobs) {
          counts[job.status] = (counts[job.status] ?? 0) + 1
        }

        return {
          queueKey,
          jobs: jobs.map((job) => ({
            id: job.id,
            queueKey: job.queueKey,
            status: job.status,
            enqueuedAt: job.enqueuedAt.toISOString(),
            startedAt: job.startedAt != null ? job.startedAt.toISOString() : null,
            error: job.error,
          })),
          counts,
        }
      })

      // Build summary
      const totalByStatus: Record<string, number> = {}
      for (const job of allJobs) {
        totalByStatus[job.status] = (totalByStatus[job.status] ?? 0) + 1
      }

      // Count queue keys with at least one queued or in-progress job
      let activeQueueKeys = 0
      for (const jobs of groupedByKey.values()) {
        const hasActive = jobs.some((j) => j.status === 'queued' || j.status === 'in-progress')
        if (hasActive) activeQueueKeys++
      }

      res.json({
        summary: {
          activeQueueKeys,
          totalByStatus,
        },
        queues,
      })
    } catch {
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ── GET /api/logs ───────────────────────────────────────────

  router.get('/api/logs', async (req, res) => {
    try {
      const { sessionLogDir } = deps

      let entries: Array<{ filename: string; sizeBytes: number; createdAt: string }>

      try {
        const files = await fs.readdir(sessionLogDir)
        const stats = await Promise.all(
          files.map(async (filename) => {
            const filePath = path.join(sessionLogDir, filename)
            const stat = await fs.stat(filePath)
            return {
              filename,
              sizeBytes: stat.size,
              createdAt: stat.birthtime.toISOString(),
            }
          }),
        )

        // Sort by creation date descending
        stats.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        entries = stats
      } catch {
        // Directory doesn't exist or can't be read — return empty list
        entries = []
      }

      // Paginate (max 50 per page)
      const page = Math.max(1, parseInt(req.query['page'] as string, 10) || 1)
      const pageSize = Math.min(
        50,
        Math.max(1, parseInt(req.query['pageSize'] as string, 10) || 50),
      )
      const total = entries.length
      const totalPages = Math.ceil(total / pageSize)
      const startIndex = (page - 1) * pageSize
      const items = entries.slice(startIndex, startIndex + pageSize)

      res.json({
        items,
        total,
        page,
        pageSize,
        totalPages,
      })
    } catch {
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ── GET /api/logs/:filename ─────────────────────────────────

  const MAX_LOG_SIZE = 5_242_880 // 5 MB

  router.get('/api/logs/:filename', async (req, res) => {
    try {
      const { filename } = req.params

      // Validate filename (path traversal protection)
      if (!isValidLogFilename(filename)) {
        res.status(404).json({ error: 'File not found' })
        return
      }

      const filePath = path.join(deps.sessionLogDir, filename)

      let content: string
      try {
        const buffer = await fs.readFile(filePath)
        if (buffer.length > MAX_LOG_SIZE) {
          content =
            buffer.subarray(0, MAX_LOG_SIZE).toString('utf-8') +
            '\n\n[truncated — file exceeds 5 MB]'
        } else {
          content = buffer.toString('utf-8')
        }
      } catch {
        res.status(404).json({ error: 'File not found' })
        return
      }

      res.setHeader('Content-Type', 'text/plain')
      res.send(content)
    } catch {
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ── GET /api/summary ──────────────────────────────────────

  router.get('/api/summary', (_req, res) => {
    try {
      const { jobQueue, startedAt } = deps

      // Compute uptime
      const uptimeMs = Date.now() - startedAt.getTime()
      const totalMinutes = Math.floor(uptimeMs / 60_000)
      const days = Math.floor(totalMinutes / (60 * 24))
      const hours = Math.floor((totalMinutes % (60 * 24)) / 60)
      const minutes = totalMinutes % 60

      // Aggregate task counts by status
      const a2aTasks = a2aTaskStore.getAll()
      const mcpTasks = mcpTaskStore.getAll()

      const statusKeys = ['submitted', 'working', 'completed', 'failed', 'canceled'] as const
      const totalCounts: Record<string, number> = {}
      const manualCounts: Record<string, number> = {}
      const webhookCounts: Record<string, number> = {}

      for (const key of statusKeys) {
        totalCounts[key] = 0
        manualCounts[key] = 0
        webhookCounts[key] = 0
      }

      for (const task of a2aTasks) {
        totalCounts[task.status] = (totalCounts[task.status] ?? 0) + 1
      }

      for (const task of mcpTasks) {
        totalCounts[task.status] = (totalCounts[task.status] ?? 0) + 1
        if (task.queueKey.includes(':manual-')) {
          manualCounts[task.status] = (manualCounts[task.status] ?? 0) + 1
        }
      }

      // Count webhook jobs
      const webhookJobs = jobQueue.getAllJobs()
      for (const job of webhookJobs) {
        const mappedStatus = mapJobStatus(job.status)
        totalCounts[mappedStatus] = (totalCounts[mappedStatus] ?? 0) + 1
        webhookCounts[mappedStatus] = (webhookCounts[mappedStatus] ?? 0) + 1
      }

      // Compute active queue count: queue keys with at least one queued or in-progress job
      const allJobs = jobQueue.getAllJobs()
      const activeQueueKeys = new Set<string>()
      for (const job of allJobs) {
        if (job.status === 'queued' || job.status === 'in-progress') {
          activeQueueKeys.add(job.queueKey)
        }
      }

      res.json({
        health: 'healthy',
        uptime: { days, hours, minutes },
        taskCounts: {
          total: totalCounts,
          manual: manualCounts,
          webhook: webhookCounts,
        },
        activeQueueCount: activeQueueKeys.size,
      })
    } catch {
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ── POST /api/tasks ───────────────────────────────────────

  router.post('/api/tasks', express.json(), (req, res) => {
    try {
      const { mcpTaskHandler, mcpTaskStore: mcpStore } = deps

      // Validate input using the same rules as MCP rocky/executeTask
      const parseResult = mcpTaskHandler.parseTaskInput((req.body ?? {}) as Record<string, unknown>)

      if (isValidationError(parseResult)) {
        res.status(400).json({
          error: 'Validation failed',
          details: { field: parseResult.field, message: parseResult.message },
        })
        return
      }

      // Extract repo full name from validated URL
      const repoFullName = extractRepoFullName(parseResult.repoUrl)

      // Create task in MCP store — it generates a standard queue key
      const task = mcpStore.create(parseResult, repoFullName)

      // Override the queue key to use `:manual-` for classification
      const manualQueueKey = `${repoFullName}:manual-${task.id}`
      ;(task as { queueKey: string }).queueKey = manualQueueKey

      // Enqueue the job for async execution
      if (deps.enqueueJob) {
        deps.enqueueJob(manualQueueKey, async () => {
          await mcpTaskHandler.executeTask(task)
        })
      }

      // Update status to working
      mcpStore.updateStatus(task.id, 'working')

      // Return the created task as UnifiedTask
      res.status(201).json(serializeMCPTask(task))
    } catch {
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ── POST /api/tasks/:id/cancel ────────────────────────────

  router.post('/api/tasks/:id/cancel', async (req, res) => {
    try {
      const { id } = req.params
      const {
        a2aTaskStore: a2aStore,
        mcpTaskStore: mcpStore,
        mcpTaskHandler,
        a2aTaskHandler,
      } = deps

      // Determine which store owns the task and cancel via the appropriate handler
      const a2aTask = a2aStore.get(id)
      if (a2aTask != null) {
        if (!a2aTaskHandler) {
          res.status(501).json({ error: 'A2A task cancellation is not available' })
          return
        }
        const canceled = await a2aTaskHandler.cancelTask(id)
        if (!canceled) {
          res.status(409).json({ error: 'Task cannot be canceled in its current state' })
          return
        }
        const updated = a2aStore.get(id)
        if (updated == null) {
          res.status(404).json({ error: 'Task not found' })
          return
        }
        res.json(serializeA2ATask(updated))
        return
      }

      const mcpTask = mcpStore.get(id)
      if (mcpTask != null) {
        const canceled = await mcpTaskHandler.cancelTask(id)
        if (!canceled) {
          res.status(409).json({ error: 'Task cannot be canceled in its current state' })
          return
        }
        const updated = mcpStore.get(id)
        if (updated == null) {
          res.status(404).json({ error: 'Task not found' })
          return
        }
        res.json(serializeMCPTask(updated))
        return
      }

      res.status(404).json({ error: 'Task not found' })
    } catch {
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ── GET /api/agents ───────────────────────────────────────

  router.get('/api/agents', (_req, res) => {
    if (deps.agentRegistry == null) {
      res.json({ agents: [], discoveredAt: null })
      return
    }
    const state = deps.agentRegistry.getState()
    res.json({ agents: state.agents, discoveredAt: state.discoveredAt })
  })

  // ── POST /api/agents/refresh ──────────────────────────────

  router.post('/api/agents/refresh', async (_req, res) => {
    if (deps.agentRegistry == null) {
      res.json({ agents: [], discoveredAt: null })
      return
    }
    try {
      const agents = await deps.agentRegistry.refresh()
      const state = deps.agentRegistry.getState()
      res.json({ agents, discoveredAt: state.discoveredAt })
    } catch (err) {
      const state = deps.agentRegistry.getState()
      res.json({
        agents: state.agents,
        discoveredAt: state.discoveredAt,
        refreshError: err instanceof Error ? err.message : String(err),
      })
    }
  })

  return router
}
