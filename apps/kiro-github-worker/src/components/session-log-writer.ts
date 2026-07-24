/**
 * Session log writer for CLI executor output.
 *
 * Writes the captured stdout and stderr from each CLI execution to a
 * dedicated file on disk — one file per execution session. Includes a
 * metadata header for context and configurable retention limits to
 * prevent unbounded disk growth.
 *
 * Integrates at the Executor_Router level so it captures output from
 * both Kiro CLI and Copilot CLI executions across all invocation modes.
 */

import { createWriteStream, type WriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import type pino from 'pino'

import type { Engine, ExecutionResult } from '../lib/types'

// ── Types ───────────────────────────────────────────────────────────

export interface SessionLogContext {
  engine: Engine
  repoFullName: string
  executionContext?: string // e.g. "issue-42", "task-abc123", "pr-17"
  agent?: string // e.g. "spec-orchestrator", "kiro_default"
}

export interface SessionLogWriterConfig {
  sessionLogDir: string
  sessionLogMaxFiles: number
  sessionLogMaxAgeHours: number
  sessionLogEnabled: boolean
}

/** A live session handle for streaming stdout/stderr to disk. */
export interface SessionHandle {
  /** Write the prompt to the session log file under a === PROMPT === section. */
  writePrompt(prompt: string): void
  /** Write the install script content under a === SETUP SCRIPT === section. */
  writeSetupScript(script: string): void
  /** Append a stdout chunk to the session log file. */
  writeStdout(chunk: string): void
  /** Append a stderr chunk to the session log file. */
  writeStderr(chunk: string): void
  /** Finalize the session: write footer with exit status, close file, trigger cleanup. */
  finalize(result: ExecutionResult): Promise<void>
  /** The file path of this session log. */
  readonly filePath: string
}

export interface SessionLogWriterInstance {
  /** Create a new streaming session. Returns a SessionHandle for real-time writing. */
  createSession(context: SessionLogContext): SessionHandle

  /** Write a session log file for the given execution result and context (batch mode). */
  writeSessionLog(result: ExecutionResult, context: SessionLogContext): Promise<void>

  /** Ensure the session log directory exists. Called once at startup. */
  ensureDirectory(): Promise<void>
}

// ── Pure Functions ──────────────────────────────────────────────────

/**
 * Sanitizes a string for use in filenames by replacing `/` with `_`
 * and removing any characters that are not alphanumeric, hyphens, or
 * underscores.
 */
const sanitize = (value: string): string =>
  value.replace(/\//g, '_').replace(/[^a-zA-Z0-9\-_]/g, '')

/**
 * Generates a filesystem-safe filename from context metadata.
 *
 * Format: `{YYYYMMDD-HHmmss-SSS}_{engine}_{safeRepoName}_{safeContext}.log`
 *
 * The timestamp-first format ensures files sort chronologically when
 * listed alphabetically.
 */
export const generateFilename = (context: SessionLogContext, timestamp?: Date): string => {
  const ts = timestamp ?? new Date()

  const year = ts.getUTCFullYear()
  const month = String(ts.getUTCMonth() + 1).padStart(2, '0')
  const day = String(ts.getUTCDate()).padStart(2, '0')
  const hours = String(ts.getUTCHours()).padStart(2, '0')
  const minutes = String(ts.getUTCMinutes()).padStart(2, '0')
  const seconds = String(ts.getUTCSeconds()).padStart(2, '0')
  const millis = String(ts.getUTCMilliseconds()).padStart(3, '0')

  const formattedTimestamp = `${year}${month}${day}-${hours}${minutes}${seconds}-${millis}`

  const safeRepoName = sanitize(context.repoFullName)
  const safeContext = sanitize(context.executionContext ?? 'unknown')

  return `${formattedTimestamp}_${context.engine}_${safeRepoName}_${safeContext}.log`
}

/**
 * Formats the session log file content with a metadata header and
 * stdout/stderr sections.
 *
 * The plain text format is human-readable without special tooling —
 * `cat`, `less`, or any text editor works.
 */
export const formatSessionLog = (
  result: ExecutionResult,
  context: SessionLogContext,
  timestamp?: Date,
  prompt?: string,
): string => {
  const ts = timestamp ?? new Date()

  const lines = [
    '=== SESSION LOG ===',
    `Timestamp: ${ts.toISOString()}`,
    `Engine: ${context.engine}`,
    `Agent: ${context.agent ?? 'default'}`,
    `Repository: ${context.repoFullName}`,
    `Context: ${context.executionContext ?? 'unknown'}`,
    `Exit Code: ${String(result.exitCode)}`,
    `Success: ${String(result.success)}`,
    `Has Changes: ${String(result.hasChanges)}`,
    '================',
    '',
  ]

  if (prompt != null) {
    lines.push('=== PROMPT ===', prompt, '=== END PROMPT ===', '')
  }

  lines.push('=== STDOUT ===', result.stdout, '', '=== STDERR ===', result.stderr)

  return lines.join('\n')
}

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Creates a session log writer that writes CLI executor output to disk
 * and manages retention cleanup.
 *
 * @param config - Session log configuration (directory, limits, enabled flag)
 * @param logger - Pino logger instance
 * @returns SessionLogWriterInstance with writeSessionLog and ensureDirectory methods
 */
export const createSessionLogWriter = (
  config: SessionLogWriterConfig,
  logger: pino.Logger,
): SessionLogWriterInstance => {
  let disabled = false

  if (config.sessionLogEnabled) {
    logger.info(
      {
        sessionLogDir: config.sessionLogDir,
        maxFiles: config.sessionLogMaxFiles,
        maxAgeHours: config.sessionLogMaxAgeHours,
      },
      'Session logging enabled — dir: %s, maxFiles: %d, maxAgeHours: %d',
      config.sessionLogDir,
      config.sessionLogMaxFiles,
      config.sessionLogMaxAgeHours,
    )
  } else {
    logger.info('Session logging is disabled')
  }

  /**
   * Creates the session log directory (including parent directories).
   * If creation fails, logs at warn level and sets the disabled flag
   * so subsequent writeSessionLog calls are no-ops.
   */
  const ensureDirectory = async (): Promise<void> => {
    if (!config.sessionLogEnabled) {
      return
    }

    try {
      await fs.mkdir(config.sessionLogDir, { recursive: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn(
        { sessionLogDir: config.sessionLogDir, error: message },
        'Failed to create session log directory: %s — session logging disabled',
        message,
      )
      disabled = true
    }
  }

  /**
   * Deletes files exceeding the age limit and then trims by count.
   * All errors are caught and logged at warn level.
   */
  const cleanupRetention = async (): Promise<void> => {
    try {
      const entries = await fs.readdir(config.sessionLogDir)
      const logFiles = entries.filter((f) => f.endsWith('.log'))

      // Stat each file to get modification time
      const fileStats = await Promise.all(
        logFiles.map(async (filename) => {
          const filePath = path.join(config.sessionLogDir, filename)
          const stat = await fs.stat(filePath)
          return { filename, filePath, mtimeMs: stat.mtimeMs }
        }),
      )

      const now = Date.now()
      const maxAgeMs = config.sessionLogMaxAgeHours * 60 * 60 * 1000
      let deletedCount = 0

      // Phase 1: Delete files older than maxAgeHours
      const remaining: typeof fileStats = []
      for (const file of fileStats) {
        if (now - file.mtimeMs > maxAgeMs) {
          try {
            await fs.unlink(file.filePath)
            deletedCount++
          } catch (unlinkErr) {
            const message = unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)
            logger.warn(
              { filePath: file.filePath, error: message },
              'Failed to delete expired session log: %s',
              message,
            )
          }
        } else {
          remaining.push(file)
        }
      }

      // Phase 2: Trim by count (delete oldest first)
      if (remaining.length > config.sessionLogMaxFiles) {
        remaining.sort((a, b) => a.mtimeMs - b.mtimeMs)
        const toDelete = remaining.slice(0, remaining.length - config.sessionLogMaxFiles)
        for (const file of toDelete) {
          try {
            await fs.unlink(file.filePath)
            deletedCount++
          } catch (unlinkErr) {
            const message = unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)
            logger.warn(
              { filePath: file.filePath, error: message },
              'Failed to delete excess session log: %s',
              message,
            )
          }
        }
      }

      if (deletedCount > 0) {
        logger.debug({ deletedCount }, 'Session log cleanup: deleted %d file(s)', deletedCount)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn(
        { sessionLogDir: config.sessionLogDir, error: message },
        'Session log cleanup failed: %s',
        message,
      )
    }
  }

  /**
   * Writes a session log file for the given execution result and context.
   *
   * 1. If disabled or not enabled, returns immediately.
   * 2. Generates filename, formats content, writes file.
   * 3. Triggers retention cleanup in fire-and-forget manner.
   * 4. Never throws — all errors are logged at warn level.
   */
  const writeSessionLog = async (
    result: ExecutionResult,
    context: SessionLogContext,
  ): Promise<void> => {
    if (!config.sessionLogEnabled || disabled) {
      return
    }

    const timestamp = new Date()
    const filename = generateFilename(context, timestamp)
    const filePath = path.join(config.sessionLogDir, filename)
    const content = formatSessionLog(result, context, timestamp)

    try {
      await fs.writeFile(filePath, content, 'utf-8')
      logger.debug({ filePath }, 'Session log written: %s', filePath)

      // Fire-and-forget cleanup
      cleanupRetention().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        logger.warn({ error: message }, 'Session log cleanup error: %s', message)
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn({ filePath, error: message }, 'Failed to write session log: %s', message)
    }
  }

  /**
   * Creates a no-op SessionHandle that does nothing.
   * Used when session logging is disabled or the writer is in a failed state.
   */
  const createNoOpHandle = (): SessionHandle => ({
    writePrompt: () => {},
    writeSetupScript: () => {},
    writeStdout: () => {},
    writeStderr: () => {},
    finalize: async () => {},
    filePath: '',
  })

  /**
   * Creates a new streaming session that writes stdout/stderr chunks
   * to disk in real time.
   *
   * If disabled or not enabled, returns a no-op SessionHandle.
   */
  const createSession = (context: SessionLogContext): SessionHandle => {
    if (!config.sessionLogEnabled || disabled) {
      return createNoOpHandle()
    }

    const timestamp = new Date()
    const filename = generateFilename(context, timestamp)
    const filePath = path.join(config.sessionLogDir, filename)

    let stream: WriteStream
    try {
      stream = createWriteStream(filePath, { encoding: 'utf-8', flags: 'a' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn({ filePath, error: message }, 'Failed to open session log stream: %s', message)
      return createNoOpHandle()
    }

    // Write metadata header immediately
    const header = [
      '=== SESSION LOG ===',
      `Timestamp: ${timestamp.toISOString()}`,
      `Engine: ${context.engine}`,
      `Agent: ${context.agent ?? 'default'}`,
      `Repository: ${context.repoFullName}`,
      `Context: ${context.executionContext ?? 'unknown'}`,
      '================',
      '',
      '',
    ].join('\n')

    stream.write(header)

    const handle: SessionHandle = {
      filePath,

      writePrompt: (prompt: string): void => {
        try {
          stream.write(`=== PROMPT ===\n${prompt}\n=== END PROMPT ===\n\n`)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logger.warn({ filePath, error: message }, 'Failed to write prompt: %s', message)
        }
      },

      writeSetupScript: (script: string): void => {
        try {
          stream.write(`=== SETUP SCRIPT ===\n${script}\n=== END SETUP SCRIPT ===\n\n`)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logger.warn({ filePath, error: message }, 'Failed to write setup script: %s', message)
        }
      },

      writeStdout: (chunk: string): void => {
        try {
          stream.write(`[STDOUT ${new Date().toISOString()}] ${chunk}`)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logger.warn({ filePath, error: message }, 'Failed to write stdout chunk: %s', message)
        }
      },

      writeStderr: (chunk: string): void => {
        try {
          stream.write(`[STDERR ${new Date().toISOString()}] ${chunk}`)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logger.warn({ filePath, error: message }, 'Failed to write stderr chunk: %s', message)
        }
      },

      finalize: async (result: ExecutionResult): Promise<void> => {
        try {
          const footer = [
            '',
            '=== SESSION COMPLETE ===',
            `Exit Code: ${String(result.exitCode)}`,
            `Success: ${String(result.success)}`,
            `Has Changes: ${String(result.hasChanges)}`,
            '========================',
            '',
          ].join('\n')

          stream.write(footer)

          await new Promise<void>((resolve, reject) => {
            stream.end(() => resolve())
            stream.on('error', reject)
          })

          logger.debug({ filePath }, 'Session log finalized: %s', filePath)

          // Fire-and-forget cleanup
          cleanupRetention().catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err)
            logger.warn({ error: message }, 'Session log cleanup error: %s', message)
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logger.warn({ filePath, error: message }, 'Failed to finalize session log: %s', message)
        }
      },
    }

    return handle
  }

  return { createSession, writeSessionLog, ensureDirectory }
}
