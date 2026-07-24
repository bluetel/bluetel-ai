/**
 * Kiro CLI executor for headless code generation.
 *
 * Invokes the Kiro CLI as a child process with a constructed prompt,
 * enforces a configurable timeout by spawning in a new process group
 * and killing the entire group on timeout (SIGKILL to -pid), and verifies
 * that Kiro CLI pushed new commits to the remote branch after completion.
 *
 * The executor does NOT perform `git add`, `git commit`, or `git push`
 * itself — the Kiro CLI is responsible for all git operations.
 *
 * Factory function `createKiroExecutor` returns an `execute` function
 * bound to the given config and logger.
 */

import type pino from 'pino'

import {
  getCurrentBranch,
  getRemoteHeadSha,
  spawnWithProcessGroupTimeout,
  verifyPushedCommits,
} from '../lib/executor-process'
import type { ExecutionResult } from '../lib/types'

import type { SessionHandle } from './session-log-writer'

// ── Config ──────────────────────────────────────────────────────────

export interface KiroExecutorConfig {
  kiroCliPath: string
  kiroApiKey: string
  timeoutMs: number
}

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Creates a Kiro CLI executor bound to the given config and logger.
 *
 * @param config - Kiro CLI path, API key, and timeout configuration
 * @param logger - Pino logger instance for structured logging
 * @returns Object with an `execute` function
 */
export const createKiroExecutor = (
  config: KiroExecutorConfig,
  logger: pino.Logger,
): {
  execute: (
    workingDir: string,
    prompt: string,
    options?: { sessionHandle?: SessionHandle; agent?: string },
  ) => Promise<ExecutionResult>
} => {
  /**
   * Invokes the Kiro CLI in headless mode and returns a structured result.
   *
   * Before execution, records the current remote branch HEAD SHA.
   * After execution, fetches from origin and checks whether new commits
   * have been pushed to the remote branch. `hasChanges` is true when
   * the remote branch has advanced beyond the pre-execution state.
   *
   * @param workingDir - The cloned repository working directory
   * @param prompt - The constructed prompt for the Kiro CLI
   * @returns ExecutionResult with success, hasChanges, stdout, stderr, and exitCode
   */
  const execute = async (
    workingDir: string,
    prompt: string,
    options?: { sessionHandle?: SessionHandle; agent?: string },
  ): Promise<ExecutionResult> => {
    const log = logger.child({ step: 'kiro-execute', workingDir })

    // Record the current branch name and remote HEAD before execution
    const branchName = await getCurrentBranch(workingDir, log)
    const preExecSha = branchName ? await getRemoteHeadSha(workingDir, branchName, log) : null

    let stdout = ''
    let stderr = ''
    let exitCode: number | null = null

    try {
      log.info({ timeoutMs: config.timeoutMs }, 'Starting Kiro CLI execution')

      const result = await spawnWithProcessGroupTimeout(
        config.kiroCliPath,
        [
          ...(options?.agent ? ['--agent', options.agent] : []),
          'chat',
          '--no-interactive',
          '--trust-all-tools',
          '--require-mcp-startup',
          prompt,
        ],
        {
          cwd: workingDir,
          env: {
            ...process.env,
            KIRO_API_KEY: config.kiroApiKey,
            CI: 'true',
          },
          timeoutMs: config.timeoutMs,
          maxBuffer: 10 * 1024 * 1024, // 10 MB
        },
        log,
        options?.sessionHandle,
      )

      stdout = result.stdout
      stderr = result.stderr
      exitCode = result.exitCode

      if (result.timedOut) {
        log.error({ timeoutMs: config.timeoutMs }, 'Kiro CLI timed out')
        stderr = `Kiro CLI timed out after ${config.timeoutMs}ms`
        exitCode = null
        return { success: false, hasChanges: false, stdout, stderr, exitCode }
      }

      if (exitCode !== 0) {
        log.error({ exitCode, stderr: stderr.slice(0, 500) }, 'Kiro CLI exited with non-zero code')
        return { success: false, hasChanges: false, stdout, stderr, exitCode }
      }

      log.info('Kiro CLI completed successfully')
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      log.error({ error: message }, 'Unexpected error during Kiro CLI execution')
      stderr = message
      return { success: false, hasChanges: false, stdout, stderr, exitCode: null }
    }

    // Verify that Kiro CLI pushed new commits to the remote branch
    const hasChanges = await verifyPushedCommits(workingDir, branchName, preExecSha, log)

    return { success: true, hasChanges, stdout, stderr, exitCode }
  }

  return { execute }
}
