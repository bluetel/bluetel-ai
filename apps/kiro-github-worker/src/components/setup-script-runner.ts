/**
 * Setup script runner for per-repository `rocky.sh` execution.
 *
 * After cloning a repository, the Worker checks for a `rocky.sh` script
 * at the repository root. If present, it is executed with a configurable
 * timeout before the Kiro CLI is invoked. This allows each repository to
 * define its own dependency installation and environment configuration
 * steps without the Worker needing repo-specific knowledge.
 *
 * The script runs with the same OS permissions as the Worker process —
 * no privilege escalation is performed.
 */

import { execFile as execFileCb } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import type { Octokit } from '@octokit/rest'
import type pino from 'pino'

import { postError } from './issue-commenter.js'

const execFile = promisify(execFileCb)

// ── Types ───────────────────────────────────────────────────────────

export interface SetupScriptResult {
  /** Whether `rocky.sh` was found and executed. */
  executed: boolean
  /** Process exit code, or null if not executed or killed by timeout. */
  exitCode: number | null
  /** Captured stdout from the script. */
  stdout: string
  /** Captured stderr from the script. */
  stderr: string
}

export interface SetupScriptRunnerConfig {
  /** Timeout in milliseconds for setup script execution. */
  setupScriptTimeoutMs: number
}

// ── Constants ───────────────────────────────────────────────────────

const SETUP_SCRIPT_NAME = 'rocky.sh'
const STEP_NAME = 'setup-script'

// ── Custom Error ────────────────────────────────────────────────────

/**
 * Error class indicating that the failure has already been reported to
 * GitHub via Issue_Commenter. Callers catching this error should NOT
 * post an additional error comment.
 */
export class AlreadyReportedError extends Error {
  readonly alreadyReported = true as const

  constructor(message: string) {
    super(message)
    this.name = 'AlreadyReportedError'
  }
}

/**
 * Type guard to check if an error has already been reported to GitHub.
 * Works with both `AlreadyReportedError` instances and duck-typed objects.
 */
export const isAlreadyReportedError = (error: unknown): boolean =>
  error instanceof AlreadyReportedError ||
  (error instanceof Error && 'alreadyReported' in error && error.alreadyReported === true)

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Type guard for AbortError (thrown when AbortController signal fires).
 */
const isAbortError = (error: unknown): boolean => {
  if (error instanceof Error) {
    return error.name === 'AbortError' || ('code' in error && error.code === 'ABORT_ERR')
  }
  return false
}

/**
 * Type guard for child_process exec errors that include stdout/stderr/code.
 */
interface ExecError extends Error {
  stdout?: string
  stderr?: string
  code?: number
}

const isExecError = (error: unknown): error is ExecError =>
  error instanceof Error && ('stdout' in error || 'stderr' in error)

// ── Public API ──────────────────────────────────────────────────────

/**
 * Checks for and executes the optional `rocky.sh` setup script in the
 * given working directory.
 *
 * @param workingDir - The cloned repository working directory
 * @param repoFullName - Repository full name (e.g. `owner/repo`) for logging and error reporting
 * @param issueNumber - Issue number for logging and error reporting
 * @param config - Setup script timeout configuration
 * @param octokit - Authenticated Octokit instance for error reporting via Issue_Commenter
 * @param logger - Pino logger instance for structured logging
 * @returns SetupScriptResult indicating whether the script ran and its output
 * @throws Error if the script exits with non-zero code or times out (after reporting to Issue_Commenter)
 */
export const runSetupScript = async (
  workingDir: string,
  repoFullName: string,
  issueNumber: number,
  config: SetupScriptRunnerConfig,
  octokit: Octokit,
  logger: pino.Logger,
): Promise<SetupScriptResult> => {
  const log = logger.child({ repo: repoFullName, issueNumber, step: STEP_NAME })

  const scriptPath = path.join(workingDir, SETUP_SCRIPT_NAME)

  // Check for the presence of rocky.sh
  if (!fs.existsSync(scriptPath)) {
    log.info('No rocky.sh found — skipping setup script')
    return { executed: false, exitCode: null, stdout: '', stderr: '' }
  }

  log.info({ timeoutMs: config.setupScriptTimeoutMs }, 'Found rocky.sh — executing setup script')

  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, config.setupScriptTimeoutMs)

  try {
    const result = await execFile('bash', [SETUP_SCRIPT_NAME], {
      cwd: workingDir,
      signal: controller.signal,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
    })

    const { stdout, stderr } = result

    log.info({ stdout, stderr }, 'Setup script completed successfully')

    return { executed: true, exitCode: 0, stdout, stderr }
  } catch (error: unknown) {
    // ── Timeout ───────────────────────────────────────────────────
    if (isAbortError(error)) {
      const message = `Setup script timed out after ${config.setupScriptTimeoutMs}ms`
      log.error({ timeoutMs: config.setupScriptTimeoutMs }, message)

      await postError(octokit, repoFullName, issueNumber, STEP_NAME, message)

      throw new AlreadyReportedError(message)
    }

    // ── Non-zero exit ─────────────────────────────────────────────
    if (isExecError(error)) {
      const stdout = error.stdout ?? ''
      const stderr = error.stderr ?? ''
      const exitCode = error.code ?? 1

      log.info({ stdout, stderr }, 'Setup script output')
      log.error(
        { exitCode, stderr: stderr.slice(0, 500) },
        'Setup script exited with non-zero code',
      )

      const message = `Setup script exited with code ${String(exitCode)}: ${stderr.slice(0, 500)}`
      await postError(octokit, repoFullName, issueNumber, STEP_NAME, message)

      throw new AlreadyReportedError(message)
    }

    // ── Unexpected error ──────────────────────────────────────────
    const message = error instanceof Error ? error.message : String(error)
    log.error({ error: message }, 'Unexpected error during setup script execution')

    await postError(octokit, repoFullName, issueNumber, STEP_NAME, message)

    throw new AlreadyReportedError(message)
  } finally {
    clearTimeout(timeout)
  }
}
