/**
 * Repository cloner for isolated working directory management.
 *
 * Clones repositories to unique temporary directories and manages
 * branch checkout for new issues and follow-up comments. Uses
 * `child_process.execFile` (promisified) for git commands and
 * `fs.promises` for directory management.
 *
 * Factory function `createRepoCloner` returns four functions:
 * - `cloneForNewIssue`: clone using the default branch
 * - `cloneForFollowUp`: clone and checkout an existing branch
 * - `cloneAtBranch`: shallow clone at a specific branch (A2A mode)
 * - `cleanup`: remove the working directory
 */

import { execFile as execFileCb } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { promisify } from 'node:util'

import type { Octokit } from '@octokit/rest'
import type pino from 'pino'

import type { CloneResult } from '../lib/types.js'

import { postConflict, postError } from './issue-commenter'
import { AlreadyReportedError, isAlreadyReportedError, runSetupScript } from './setup-script-runner'

const execFile = promisify(execFileCb)

// ── Config ──────────────────────────────────────────────────────────

export interface RepoClonerConfig {
  workingDirBase: string
  setupScriptTimeoutMs: number
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Builds a unique working directory path for a clone operation.
 *
 * Format: `{workingDirBase}/rocky-{repo}-{issue}-{timestamp}`
 * where `/` in the repo name is replaced with `-`.
 *
 * @internal Exported for testing (Property 17).
 */
export const buildWorkingDirPath = (
  workingDirBase: string,
  repoFullName: string,
  issueNumber: number,
): string => {
  const safeRepo = repoFullName.replace(/\//g, '-')
  const timestamp = Date.now()
  return `${workingDirBase}/rocky-${safeRepo}-${issueNumber}-${timestamp}`
}

/**
 * Builds a unique working directory path for an A2A clone operation.
 *
 * Format: `{workingDirBase}/rocky-a2a-{repo}-{timestamp}`
 * where `/` in the repo name is replaced with `-`.
 *
 * @internal Exported for testing.
 */
export const buildA2AWorkingDirPath = (workingDirBase: string, repoFullName: string): string => {
  const safeRepo = repoFullName.replace(/\//g, '-')
  const timestamp = Date.now()
  return `${workingDirBase}/rocky-a2a-${safeRepo}-${timestamp}`
}

/**
 * Builds the HTTPS clone URL with embedded token authentication.
 */
const buildCloneUrl = (repoFullName: string, token: string): string =>
  `https://x-access-token:${token}@github.com/${repoFullName}.git`

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Creates a repo cloner bound to the given config and logger.
 *
 * @param config - Working directory base path configuration
 * @param logger - Pino logger instance for structured logging
 * @returns Object with `cloneForNewIssue`, `cloneForFollowUp`, and `cleanup`
 */
export const createRepoCloner = (
  config: RepoClonerConfig,
  logger: pino.Logger,
): {
  cloneForNewIssue: (
    repoFullName: string,
    issueNumber: number,
    token: string,
    octokit: Octokit,
  ) => Promise<CloneResult>
  cloneForFollowUp: (
    repoFullName: string,
    issueNumber: number,
    branchName: string,
    token: string,
    octokit: Octokit,
  ) => Promise<CloneResult>
  cloneAtBranch: (repoFullName: string, branchName: string, token: string) => Promise<CloneResult>
  cleanup: (workingDir: string) => Promise<void>
} => {
  /**
   * Clones a repository to a unique working directory using the default branch.
   *
   * @param repoFullName - Repository full name (e.g. `owner/repo`)
   * @param issueNumber - Issue number for directory naming
   * @param token - GitHub auth token for HTTPS clone
   * @param octokit - Authenticated Octokit instance for error reporting
   * @returns CloneResult with the working directory path and branch name
   */
  const cloneForNewIssue = async (
    repoFullName: string,
    issueNumber: number,
    token: string,
    octokit: Octokit,
  ): Promise<CloneResult> => {
    const workingDir = buildWorkingDirPath(config.workingDirBase, repoFullName, issueNumber)
    const log = logger.child({ repo: repoFullName, issueNumber, step: 'clone', workingDir })

    await mkdir(workingDir, { recursive: true })
    log.info('Created working directory')

    const cloneUrl = buildCloneUrl(repoFullName, token)

    try {
      await execFile('git', ['clone', '--depth=1', cloneUrl, workingDir])
      log.info('Repository cloned successfully')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error({ error: message }, 'Clone failed')
      await postError(octokit, repoFullName, issueNumber, 'clone', message)
      throw new AlreadyReportedError(message)
    }

    // Determine the default branch name from the cloned repo
    let branch: string
    try {
      const { stdout } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: workingDir,
      })
      branch = stdout.trim()
    } catch {
      branch = 'main'
    }

    // Run optional per-repo setup script (rocky.sh) after clone
    const setupResult = await runSetupScript(
      workingDir,
      repoFullName,
      issueNumber,
      config,
      octokit,
      logger,
    )

    log.info({ branch }, 'Clone complete on default branch')
    return {
      workingDir,
      branch,
      ...(setupResult.executed ? { setupScriptResult: setupResult } : {}),
    }
  }

  /**
   * Clones a repository and checks out an existing branch for follow-up work.
   *
   * Also checks for merge conflicts between the branch and the default branch
   * using `git merge-base --is-ancestor`.
   *
   * @param repoFullName - Repository full name (e.g. `owner/repo`)
   * @param issueNumber - Issue number for directory naming
   * @param branchName - Existing branch to check out
   * @param token - GitHub auth token for HTTPS clone
   * @param octokit - Authenticated Octokit instance for error reporting
   * @returns CloneResult with the working directory path and branch name
   */
  const cloneForFollowUp = async (
    repoFullName: string,
    issueNumber: number,
    branchName: string,
    token: string,
    octokit: Octokit,
  ): Promise<CloneResult> => {
    const workingDir = buildWorkingDirPath(config.workingDirBase, repoFullName, issueNumber)
    const log = logger.child({
      repo: repoFullName,
      issueNumber,
      step: 'clone-follow-up',
      workingDir,
      branchName,
    })

    await mkdir(workingDir, { recursive: true })
    log.info('Created working directory')

    const cloneUrl = buildCloneUrl(repoFullName, token)

    try {
      // Clone without depth limit so we can check merge-base
      await execFile('git', ['clone', cloneUrl, workingDir])
      log.info('Repository cloned successfully')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error({ error: message }, 'Clone failed')
      await postError(octokit, repoFullName, issueNumber, 'clone', message)
      throw new AlreadyReportedError(message)
    }

    // Checkout the existing branch
    try {
      await execFile('git', ['checkout', branchName], { cwd: workingDir })
      log.info({ branchName }, 'Checked out existing branch')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error({ error: message, branchName }, 'Branch checkout failed')
      await postError(octokit, repoFullName, issueNumber, 'checkout', message)
      throw new AlreadyReportedError(message)
    }

    // Check for merge conflicts with the default branch
    try {
      // Get the default branch name
      const { stdout: defaultBranchRaw } = await execFile(
        'git',
        ['rev-parse', '--abbrev-ref', 'origin/HEAD'],
        { cwd: workingDir },
      )
      const defaultBranch = defaultBranchRaw.trim().replace(/^origin\//, '')

      // Check if the default branch is an ancestor of the feature branch.
      // If not, there may be merge conflicts.
      try {
        await execFile(
          'git',
          ['merge-base', '--is-ancestor', `origin/${defaultBranch}`, branchName],
          { cwd: workingDir },
        )
        log.debug('No merge conflicts detected')
      } catch {
        // merge-base --is-ancestor exits non-zero when not an ancestor,
        // which indicates potential merge conflicts
        log.warn({ branchName, defaultBranch }, 'Branch may have merge conflicts')
        await postConflict(octokit, repoFullName, issueNumber)
        throw new AlreadyReportedError(
          `Branch '${branchName}' has merge conflicts with '${defaultBranch}'. Please resolve them before continuing.`,
        )
      }
    } catch (error) {
      // Re-throw already-reported errors (conflict or other)
      if (isAlreadyReportedError(error)) {
        throw error
      }
      // If we can't determine the default branch, log a warning but continue
      log.warn('Could not determine default branch for merge conflict check; continuing anyway')
    }

    // Run optional per-repo setup script (rocky.sh) after clone
    const setupResult = await runSetupScript(
      workingDir,
      repoFullName,
      issueNumber,
      config,
      octokit,
      logger,
    )

    return {
      workingDir,
      branch: branchName,
      ...(setupResult.executed ? { setupScriptResult: setupResult } : {}),
    }
  }

  /**
   * Clones a repository at a specific branch for A2A task execution.
   *
   * Uses a shallow clone (`--depth=1 --branch`) for efficiency. Does NOT
   * check for merge conflicts or call Issue_Commenter — A2A reports errors
   * through the task store. Does NOT run `rocky.sh` setup scripts — A2A
   * uses caller-provided install scripts instead.
   *
   * @param repoFullName - Repository full name (e.g. `owner/repo`)
   * @param branchName - Branch to clone
   * @param token - GitHub auth token for HTTPS clone
   * @returns CloneResult with the working directory path and branch name
   * @throws On clone failure so A2A_Task_Handler can catch and report via task store
   */
  const cloneAtBranch = async (
    repoFullName: string,
    branchName: string,
    token: string,
  ): Promise<CloneResult> => {
    const workingDir = buildA2AWorkingDirPath(config.workingDirBase, repoFullName)
    const log = logger.child({
      repo: repoFullName,
      step: 'clone-a2a',
      workingDir,
      branchName,
    })

    await mkdir(workingDir, { recursive: true })
    log.info('Created working directory')

    const cloneUrl = buildCloneUrl(repoFullName, token)

    try {
      await execFile('git', ['clone', '--depth=1', '--branch', branchName, cloneUrl, '.'], {
        cwd: workingDir,
      })
      log.info('Repository cloned successfully')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error({ error: message }, 'Clone failed')
      throw error
    }

    log.info({ branch: branchName }, 'A2A clone complete')
    return { workingDir, branch: branchName }
  }

  /**
   * Removes a working directory and all its contents.
   *
   * Intended to be called in a `finally` block to ensure cleanup
   * regardless of success or failure.
   *
   * @param workingDir - Path to the working directory to remove
   */
  const cleanup = async (workingDir: string): Promise<void> => {
    const log = logger.child({ step: 'cleanup', workingDir })
    try {
      await rm(workingDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      log.info('Working directory cleaned up')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn({ error: message }, 'Failed to clean up working directory')
    }
  }

  return { cloneForNewIssue, cloneForFollowUp, cloneAtBranch, cleanup }
}
