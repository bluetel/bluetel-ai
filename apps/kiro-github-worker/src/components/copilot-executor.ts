/**
 * Copilot CLI executor for headless code generation.
 *
 * Invokes the GitHub Copilot CLI as a child process with a caller-provided
 * prompt, enforces a configurable timeout by spawning in a new process group
 * and killing the entire group on timeout (SIGKILL to -pid), and verifies
 * that the Copilot CLI pushed new commits to the remote branch after completion.
 *
 * The executor does NOT perform `git add`, `git commit`, or `git push`
 * itself — the Copilot CLI is responsible for all git operations.
 *
 * Factory function `createCopilotExecutor` returns an `execute` function
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

export interface CopilotExecutorConfig {
  copilotCliPath: string
  copilotGithubToken?: string
  timeoutMs: number
}

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Creates a Copilot CLI executor bound to the given config and logger.
 *
 * @param config - Copilot CLI path, token, and timeout configuration
 * @param logger - Pino logger instance for structured logging
 * @returns Object with an `execute` function
 */
export const createCopilotExecutor = (
  config: CopilotExecutorConfig,
  logger: pino.Logger,
): {
  execute: (
    workingDir: string,
    prompt: string,
    options?: { sessionHandle?: SessionHandle },
  ) => Promise<ExecutionResult>
} => {
  /**
   * Invokes the Copilot CLI and returns a structured result.
   *
   * Before execution, records the current remote branch HEAD SHA.
   * After execution, fetches from origin and checks whether new commits
   * have been pushed to the remote branch. `hasChanges` is true when
   * the remote branch has advanced beyond the pre-execution state.
   *
   * @param workingDir - The cloned repository working directory
   * @param prompt - The prompt for the Copilot CLI
   * @returns ExecutionResult with success, hasChanges, stdout, stderr, and exitCode
   */
  const execute = async (
    workingDir: string,
    prompt: string,
    options?: { sessionHandle?: SessionHandle },
  ): Promise<ExecutionResult> => {
    const log = logger.child({ step: 'copilot-execute', workingDir })

    // Record the current branch name and remote HEAD before execution
    const branchName = await getCurrentBranch(workingDir, log)
    const preExecSha = branchName ? await getRemoteHeadSha(workingDir, branchName, log) : null

    let stdout = ''
    let stderr = ''
    let exitCode: number | null = null

    try {
      log.info({ timeoutMs: config.timeoutMs }, 'Starting Copilot CLI execution')

      // Build a restricted env that strips other GitHub tokens from process.env
      // to prevent the Copilot CLI from accidentally using the wrong credentials.
      // E.g. Github classic token can be used for clone-ops but not supported by copilot executor.
      const sanitizedEnv = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !/^(GITHUB_TOKEN|GH_TOKEN|GITHUB_PAT|GH_PAT)$/i.test(key) &&
            !/^(GITHUB_APP_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/i.test(key),
        ),
      )

      const result = await spawnWithProcessGroupTimeout(
        config.copilotCliPath,
        ['-p', prompt, '--allow-all', '--no-ask-user'],
        {
          cwd: workingDir,
          env: {
            ...sanitizedEnv,
            ...(config.copilotGithubToken != null
              ? { COPILOT_GITHUB_TOKEN: config.copilotGithubToken }
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
        log.error({ engine: 'copilot', timeoutMs: config.timeoutMs }, 'Copilot CLI timed out')
        stderr = `Copilot CLI timed out after ${config.timeoutMs}ms`
        exitCode = null
        return { success: false, hasChanges: false, stdout, stderr, exitCode }
      }

      if (exitCode !== 0) {
        log.error(
          { engine: 'copilot', exitCode, stderr: stderr.slice(0, 500) },
          'Copilot CLI exited with non-zero code',
        )
        return { success: false, hasChanges: false, stdout, stderr, exitCode }
      }

      log.info('Copilot CLI completed successfully')
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      log.error(
        { engine: 'copilot', error: message },
        'Unexpected error during Copilot CLI execution',
      )
      stderr = message
      return { success: false, hasChanges: false, stdout, stderr, exitCode: null }
    }

    // Verify that Copilot CLI pushed new commits to the remote branch
    const hasChanges = await verifyPushedCommits(workingDir, branchName, preExecSha, log)

    return { success: true, hasChanges, stdout, stderr, exitCode }
  }

  return { execute }
}
