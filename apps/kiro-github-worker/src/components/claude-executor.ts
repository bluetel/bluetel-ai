/**
 * Claude Code CLI executor for headless code generation.
 *
 * Invokes the Claude Code CLI as a child process with a caller-provided
 * prompt, enforces a configurable timeout by spawning in a new process group
 * and killing the entire group on timeout (SIGKILL to -pid), and verifies
 * that the Claude Code CLI pushed new commits to the remote branch after
 * completion.
 *
 * The executor does NOT perform `git add`, `git commit`, or `git push`
 * itself — the Claude Code CLI is responsible for all git operations (it is
 * instructed to commit and push by the prompt, and runs with permissions
 * bypassed so it can use the Bash/git tools without prompting).
 *
 * Factory function `createClaudeExecutor` returns an `execute` function
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

export interface ClaudeExecutorConfig {
  claudeCliPath: string
  anthropicApiKey?: string
  timeoutMs: number
}

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Creates a Claude Code CLI executor bound to the given config and logger.
 *
 * @param config - Claude Code CLI path, API key, and timeout configuration
 * @param logger - Pino logger instance for structured logging
 * @returns Object with an `execute` function
 */
export const createClaudeExecutor = (
  config: ClaudeExecutorConfig,
  logger: pino.Logger,
): {
  execute: (
    workingDir: string,
    prompt: string,
    options?: { sessionHandle?: SessionHandle },
  ) => Promise<ExecutionResult>
} => {
  /**
   * Invokes the Claude Code CLI in headless mode and returns a structured result.
   *
   * Before execution, records the current remote branch HEAD SHA.
   * After execution, fetches from origin and checks whether new commits
   * have been pushed to the remote branch. `hasChanges` is true when
   * the remote branch has advanced beyond the pre-execution state.
   *
   * @param workingDir - The cloned repository working directory
   * @param prompt - The prompt for the Claude Code CLI
   * @returns ExecutionResult with success, hasChanges, stdout, stderr, and exitCode
   */
  const execute = async (
    workingDir: string,
    prompt: string,
    options?: { sessionHandle?: SessionHandle },
  ): Promise<ExecutionResult> => {
    const log = logger.child({ step: 'claude-execute', workingDir })

    // Record the current branch name and remote HEAD before execution
    const branchName = await getCurrentBranch(workingDir, log)
    const preExecSha = branchName ? await getRemoteHeadSha(workingDir, branchName, log) : null

    let stdout = ''
    let stderr = ''
    let exitCode: number | null = null

    try {
      log.info({ timeoutMs: config.timeoutMs }, 'Starting Claude Code CLI execution')

      const result = await spawnWithProcessGroupTimeout(
        config.claudeCliPath,
        ['-p', prompt, '--permission-mode', 'bypassPermissions', '--output-format', 'text'],
        {
          cwd: workingDir,
          env: {
            ...process.env,
            ...(config.anthropicApiKey != null
              ? { ANTHROPIC_API_KEY: config.anthropicApiKey }
              : {}),
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
        log.error({ engine: 'claude', timeoutMs: config.timeoutMs }, 'Claude Code CLI timed out')
        stderr = `Claude Code CLI timed out after ${config.timeoutMs}ms`
        exitCode = null
        return { success: false, hasChanges: false, stdout, stderr, exitCode }
      }

      if (exitCode !== 0) {
        log.error(
          { engine: 'claude', exitCode, stderr: stderr.slice(0, 500) },
          'Claude Code CLI exited with non-zero code',
        )
        return { success: false, hasChanges: false, stdout, stderr, exitCode }
      }

      log.info('Claude Code CLI completed successfully')
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      log.error(
        { engine: 'claude', error: message },
        'Unexpected error during Claude Code CLI execution',
      )
      stderr = message
      return { success: false, hasChanges: false, stdout, stderr, exitCode: null }
    }

    // Verify that Claude Code CLI pushed new commits to the remote branch
    const hasChanges = await verifyPushedCommits(workingDir, branchName, preExecSha, log)

    return { success: true, hasChanges, stdout, stderr, exitCode }
  }

  return { execute }
}
