/**
 * Summarizer module for generating concise AI-powered task summaries.
 *
 * Invokes the Kiro CLI with the "qwen3-coder-next" model to produce
 * short summaries of task prompts and results. Uses the same process
 * group kill pattern as kiro-executor.ts to prevent orphaned processes.
 *
 * Factory function `createSummarizer` returns a `SummarizerInstance`
 * bound to the given config and logger.
 */

import { spawn } from 'node:child_process'

import type pino from 'pino'

// ── Config ──────────────────────────────────────────────────────────

export interface SummarizerConfig {
  kiroCliPath: string
  kiroApiKey: string
  timeoutMs: number // Default: 30_000
}

// ── Instance ────────────────────────────────────────────────────────

export interface SummarizerInstance {
  generateSummary: (input: string) => Promise<string | null>
}

// ── Constants ───────────────────────────────────────────────────────

const MAX_SUMMARY_LENGTH = 256

/** Strips ANSI escape sequences from a string. */
const stripAnsi = (str: string): string =>
  // eslint-disable-next-line no-control-regex
  str.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)/g, '')

const SUMMARIZATION_PROMPT_TEMPLATE = `Summarize in ONE short sentence (max 100 characters). State the action and target only. No filler words. Output ONLY the summary, nothing else.

---
{input}
---`

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Creates a Summarizer instance bound to the given config and logger.
 *
 * @param config - Kiro CLI path, API key, and timeout configuration
 * @param logger - Pino logger instance for structured logging
 * @returns SummarizerInstance with a `generateSummary` function
 */
export const createSummarizer = (
  config: SummarizerConfig,
  logger: pino.Logger,
): SummarizerInstance => {
  const generateSummary = async (input: string): Promise<string | null> => {
    if (input === '') {
      return null
    }

    const cleanInput = stripAnsi(input)
    if (cleanInput === '') {
      return null
    }

    const prompt = SUMMARIZATION_PROMPT_TEMPLATE.replace('{input}', cleanInput)

    logger.info({ prompt }, 'Summarizer prompt constructed')

    const args = ['chat', '--no-interactive', '--model', 'qwen3-coder-next', prompt]

    const result = await spawnWithTimeout(
      config.kiroCliPath,
      args,
      {
        env: { ...process.env, KIRO_API_KEY: config.kiroApiKey },
        timeoutMs: config.timeoutMs,
      },
      logger,
    )

    if (result.timedOut) {
      logger.error({ timeoutMs: config.timeoutMs }, 'Summarizer CLI timed out')
      return null
    }

    if (result.exitCode !== 0) {
      logger.error(
        { exitCode: result.exitCode, stderr: result.stderr },
        'Summarizer CLI exited with non-zero code',
      )
      return null
    }

    const trimmed = result.stdout.trim()

    if (trimmed === '') {
      return null
    }

    return trimmed.length > MAX_SUMMARY_LENGTH ? trimmed.slice(0, MAX_SUMMARY_LENGTH) : trimmed
  }

  return { generateSummary }
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Generates a prompt summary asynchronously. Never throws.
 */
export const generatePromptSummary = async (
  task: { id: string; input: { prompt: string } },
  summarizer: SummarizerInstance,
  taskStore: { setPromptSummary(id: string, summary: string): void },
  logger: pino.Logger,
): Promise<void> => {
  try {
    const summary = await summarizer.generateSummary(task.input.prompt)
    if (summary != null) {
      taskStore.setPromptSummary(task.id, summary)
    }
  } catch (error) {
    logger.error({ error, taskId: task.id }, 'Failed to generate prompt summary')
  }
}

/**
 * Generates a result summary from artifacts and/or error. Never throws.
 */
export const generateResultSummary = async (
  task: {
    id: string
    artifacts: Array<{ type: string; value: string }>
    error?: { step: string; message: string }
  },
  summarizer: SummarizerInstance,
  taskStore: { setResultSummary(id: string, summary: string): void },
  logger: pino.Logger,
): Promise<void> => {
  try {
    const input = assembleResultInput(task)
    const summary = await summarizer.generateSummary(input)
    if (summary != null) {
      taskStore.setResultSummary(task.id, summary)
    }
  } catch (error) {
    logger.error({ error, taskId: task.id }, 'Failed to generate result summary')
  }
}

/**
 * Assembles the input string for result summarization from task artifacts and error.
 * Excludes install/setup artifacts to focus on actual task execution outcome.
 */
export const assembleResultInput = (task: {
  artifacts: Array<{ type: string; value: string }>
  error?: { step: string; message: string }
}): string => {
  // Exclude install/setup noise — only include execution-relevant artifacts
  const relevantArtifacts = task.artifacts.filter(
    (a) => a.type !== 'install_output' && a.type !== 'setup_output',
  )

  if (task.error != null) {
    const lines = [`Task failed at step "${task.error.step}": ${task.error.message}`]
    if (relevantArtifacts.length > 0) {
      lines.push('Artifacts collected before failure:')
      for (const artifact of relevantArtifacts) {
        lines.push(`- ${artifact.type}: ${artifact.value}`)
      }
    }
    return lines.join('\n')
  }

  const lines = ['Task outcome:']
  for (const artifact of relevantArtifacts) {
    const value = artifact.type === 'stdout' ? artifact.value.slice(0, 500) : artifact.value
    lines.push(`- ${artifact.type}: ${value}`)
  }
  return lines.join('\n')
}

// ── Internal spawn helper ───────────────────────────────────────────

interface SpawnResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
}

/**
 * Spawns a child process in a new process group and enforces a timeout
 * by killing the entire process group (SIGKILL to -pid).
 *
 * Uses the same pattern as kiro-executor.ts to prevent orphaned
 * grandchild processes.
 */
const spawnWithTimeout = (
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv
    timeoutMs: number
  },
  log: pino.Logger,
): Promise<SpawnResult> =>
  new Promise((resolve, reject) => {
    const { env, timeoutMs } = options

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const child = spawn(command, args, {
      env,
      detached: true, // Creates a new process group
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const killProcessGroup = (): void => {
      if (child.pid == null) return
      try {
        // Kill the entire process group (negative PID)
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // Process group may already be dead — try killing just the child
        try {
          child.kill('SIGKILL')
        } catch {
          // Already dead, ignore
        }
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      log.warn({ pid: child.pid, timeoutMs }, 'Summarizer timeout reached, killing process group')
      killProcessGroup()
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('error', (error: Error) => {
      clearTimeout(timer)
      if (!settled) {
        settled = true
        reject(error)
      }
    })

    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      if (!settled) {
        settled = true
        resolve({
          stdout,
          stderr,
          exitCode: code,
          timedOut,
        })
      }
    })
  })
