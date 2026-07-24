/**
 * Job queue for managing sequential execution per queue key
 * with parallel execution across different keys.
 *
 * Each queue key (derived from repo + issue/PR number) gets its own
 * FIFO queue. At most one job per key is in-progress at any time.
 * Jobs for different keys run in parallel since each gets its own
 * working directory.
 */

import type pino from 'pino'

import type { FilteredEvent, Job } from '../lib/types.js'

// ── Types ───────────────────────────────────────────────────────────

export type JobProcessor = (job: Job) => Promise<void>

export interface JobQueueInstance {
  enqueue(event: FilteredEvent): Job
  getQueuePosition(queueKey: string): number
  getJob(jobId: string): Job | undefined
  getAllJobs(): Job[]
}

// ── Queue Key Derivation ────────────────────────────────────────────

/**
 * Derives the queue key from a FilteredEvent.
 *
 * - `new_issue` and `follow_up_comment`: `{repo}:{issueNumber}`
 * - PR event types: `{repo}:{issueNumber}` if issueNumber is available,
 *   otherwise `{repo}:pr-{prNumber}`
 */
export const deriveQueueKey = (event: FilteredEvent): string => {
  switch (event.type) {
    case 'new_issue':
    case 'follow_up_comment':
      return `${event.repo}:${String(event.issueNumber)}`

    case 'pr_review_comment':
    case 'pr_review_changes_requested':
    case 'pr_comment':
      if (event.issueNumber != null) {
        return `${event.repo}:${String(event.issueNumber)}`
      }
      return `${event.repo}:pr-${String(event.prNumber)}`
  }
}

// ── Implementation ──────────────────────────────────────────────────

/**
 * Creates a JobQueue instance that manages sequential execution per
 * queue key with parallel execution across different keys.
 *
 * @param processor - Callback that executes the actual work for a job
 * @param logger - Pino logger instance
 */
export const createJobQueue = (processor: JobProcessor, logger: pino.Logger): JobQueueInstance => {
  /** Map of queue key → array of jobs (first element may be in-progress) */
  const queues = new Map<string, Job[]>()

  /** Index of job ID → Job for fast lookup */
  const jobIndex = new Map<string, Job>()

  /**
   * Starts processing the next job in the queue for the given key.
   * If no jobs are queued, removes the queue entry.
   */
  const processNext = (queueKey: string): void => {
    const queue = queues.get(queueKey)
    if (queue == null || queue.length === 0) {
      queues.delete(queueKey)
      return
    }

    const job = queue[0]
    if (job.status !== 'queued') {
      return
    }

    job.status = 'in-progress'
    job.startedAt = new Date()

    const log = logger.child({ jobId: job.id, queueKey })
    log.info('Job started')

    // Fire-and-forget: process the job asynchronously
    processor(job)
      .then(() => {
        job.status = 'completed'
        job.completedAt = new Date()
        log.info('Job completed')
      })
      .catch((err: unknown) => {
        job.status = 'failed'
        job.completedAt = new Date()
        job.error = err instanceof Error ? err.message : String(err)
        log.error({ err }, 'Job failed')
      })
      .finally(() => {
        // Remove the completed/failed job from the front of the queue
        queue.shift()

        // Start the next job if one is queued
        if (queue.length > 0) {
          processNext(queueKey)
        } else {
          queues.delete(queueKey)
        }
      })
  }

  const enqueue = (event: FilteredEvent): Job => {
    const queueKey = deriveQueueKey(event)
    const job: Job = {
      id: crypto.randomUUID(),
      queueKey,
      status: 'queued',
      event,
      enqueuedAt: new Date(),
      startedAt: null,
      completedAt: null,
      error: null,
    }

    jobIndex.set(job.id, job)

    let queue = queues.get(queueKey)
    if (queue == null) {
      queue = []
      queues.set(queueKey, queue)
    }

    queue.push(job)

    const log = logger.child({ jobId: job.id, queueKey })

    // If this is the only job in the queue, start it immediately
    if (queue.length === 1) {
      log.info('Job enqueued, starting immediately')
      processNext(queueKey)
    } else {
      const position = queue.length - 1
      log.info({ position }, 'Job enqueued, waiting in queue')
    }

    return job
  }

  const getQueuePosition = (queueKey: string): number => {
    const queue = queues.get(queueKey)
    if (queue == null) return 0
    // Position is the number of jobs waiting (excluding the in-progress one)
    return Math.max(0, queue.length - 1)
  }

  const getJob = (jobId: string): Job | undefined => jobIndex.get(jobId)

  const getAllJobs = (): Job[] => [...jobIndex.values()]

  return { enqueue, getQueuePosition, getJob, getAllJobs }
}
