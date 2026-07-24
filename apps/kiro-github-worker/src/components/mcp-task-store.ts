/**
 * In-memory task store for MCP task records.
 *
 * Tracks MCP task lifecycle: creation, status transitions, error
 * reporting, artifact collection, and completion. Tasks are stored
 * in memory for the lifetime of the Worker process.
 */

import type pino from 'pino'

import type {
  MCPTask,
  MCPTaskArtifact,
  MCPTaskInput,
  MCPTaskStatus,
  MCPTaskStore,
} from '../lib/mcp-types'

// ── Helpers ─────────────────────────────────────────────────────────

/** Strips ANSI escape sequences from a string. */
const stripAnsi = (str: string): string =>
  // eslint-disable-next-line no-control-regex
  str.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)/g, '')

// ── Implementation ──────────────────────────────────────────────────

/**
 * Creates an MCPTaskStore instance backed by an in-memory Map.
 *
 * @param logger - Pino logger instance
 */
export const createMCPTaskStore = (logger: pino.Logger): MCPTaskStore => {
  const tasks = new Map<string, MCPTask>()

  const create = (input: MCPTaskInput, repoFullName: string): MCPTask => {
    const id = crypto.randomUUID()
    const now = new Date()
    const queueKey = `${repoFullName}:mcp-${id}`

    const task: MCPTask = {
      id,
      status: 'submitted',
      input,
      repoFullName,
      queueKey,
      artifacts: [],
      promptSummary: null,
      resultSummary: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    }

    tasks.set(id, task)
    logger.info({ taskId: id, repoFullName, queueKey }, 'MCP task created')

    return task
  }

  const get = (taskId: string): MCPTask | undefined => tasks.get(taskId)

  const getAll = (): MCPTask[] => [...tasks.values()]

  const updateStatus = (taskId: string, status: MCPTaskStatus): void => {
    const task = tasks.get(taskId)
    if (task == null) return

    const previousStatus = task.status
    task.status = status
    task.updatedAt = new Date()

    logger.info({ taskId, previousStatus, status }, 'MCP task status updated')
  }

  const setError = (taskId: string, step: string, message: string): void => {
    const task = tasks.get(taskId)
    if (task == null) return

    task.error = { step: step as 'clone' | 'install' | 'kiro-cli', message }
    task.updatedAt = new Date()

    logger.info({ taskId, step, message }, 'MCP task error set')
  }

  const addArtifact = (taskId: string, artifact: MCPTaskArtifact): void => {
    const task = tasks.get(taskId)
    if (task == null) return

    task.artifacts.push({ type: artifact.type, value: stripAnsi(artifact.value) })
    task.updatedAt = new Date()

    logger.info({ taskId, artifactType: artifact.type }, 'MCP task artifact added')
  }

  const setCompleted = (taskId: string): void => {
    const task = tasks.get(taskId)
    if (task == null) return

    task.status = 'completed'
    task.updatedAt = new Date()
    task.completedAt = new Date()

    logger.info({ taskId }, 'MCP task completed')
  }

  const setPromptSummary = (taskId: string, summary: string): void => {
    const task = tasks.get(taskId)
    if (task == null) return

    task.promptSummary = summary
    task.updatedAt = new Date()

    logger.info({ taskId }, 'MCP task prompt summary set')
  }

  const setResultSummary = (taskId: string, summary: string): void => {
    const task = tasks.get(taskId)
    if (task == null) return

    task.resultSummary = summary
    task.updatedAt = new Date()

    logger.info({ taskId }, 'MCP task result summary set')
  }

  return {
    create,
    get,
    getAll,
    updateStatus,
    setError,
    addArtifact,
    setCompleted,
    setPromptSummary,
    setResultSummary,
  }
}
