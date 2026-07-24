/**
 * In-memory task store for A2A task records.
 *
 * Tracks A2A task lifecycle: creation, status transitions, error
 * reporting, artifact collection, and completion. Tasks are stored
 * in memory for the lifetime of the Worker process.
 */

import type pino from 'pino'

import type {
  A2ATask,
  A2ATaskArtifact,
  A2ATaskInput,
  A2ATaskStatus,
  A2ATaskStore,
} from '../lib/a2a-types'

// ── Helpers ─────────────────────────────────────────────────────────

/** Strips ANSI escape sequences from a string. */
const stripAnsi = (str: string): string =>
  // eslint-disable-next-line no-control-regex
  str.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)/g, '')

// ── Implementation ──────────────────────────────────────────────────

/**
 * Creates an A2ATaskStore instance backed by an in-memory Map.
 *
 * @param logger - Pino logger instance
 */
export const createA2ATaskStore = (logger: pino.Logger): A2ATaskStore => {
  const tasks = new Map<string, A2ATask>()

  const create = (input: A2ATaskInput, repoFullName: string): A2ATask => {
    const id = crypto.randomUUID()
    const now = new Date()
    const queueKey = `${repoFullName}:a2a-${id}`

    const task: A2ATask = {
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
    logger.info({ taskId: id, repoFullName, queueKey }, 'A2A task created')

    return task
  }

  const get = (taskId: string): A2ATask | undefined => tasks.get(taskId)

  const getAll = (): A2ATask[] => [...tasks.values()]

  const updateStatus = (taskId: string, status: A2ATaskStatus): void => {
    const task = tasks.get(taskId)
    if (task == null) return

    const previousStatus = task.status
    task.status = status
    task.updatedAt = new Date()

    logger.info({ taskId, previousStatus, status }, 'A2A task status updated')
  }

  const setError = (taskId: string, step: string, message: string): void => {
    const task = tasks.get(taskId)
    if (task == null) return

    task.error = { step: step as 'clone' | 'install' | 'kiro-cli', message }
    task.updatedAt = new Date()

    logger.info({ taskId, step, message }, 'A2A task error set')
  }

  const addArtifact = (taskId: string, artifact: A2ATaskArtifact): void => {
    const task = tasks.get(taskId)
    if (task == null) return

    task.artifacts.push({ type: artifact.type, value: stripAnsi(artifact.value) })
    task.updatedAt = new Date()

    logger.info({ taskId, artifactType: artifact.type }, 'A2A task artifact added')
  }

  const setCompleted = (taskId: string): void => {
    const task = tasks.get(taskId)
    if (task == null) return

    task.status = 'completed'
    task.updatedAt = new Date()
    task.completedAt = new Date()

    logger.info({ taskId }, 'A2A task completed')
  }

  const setPromptSummary = (taskId: string, summary: string): void => {
    const task = tasks.get(taskId)
    if (task == null) return

    task.promptSummary = summary
    task.updatedAt = new Date()

    logger.info({ taskId }, 'A2A task prompt summary set')
  }

  const setResultSummary = (taskId: string, summary: string): void => {
    const task = tasks.get(taskId)
    if (task == null) return

    task.resultSummary = summary
    task.updatedAt = new Date()

    logger.info({ taskId }, 'A2A task result summary set')
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
