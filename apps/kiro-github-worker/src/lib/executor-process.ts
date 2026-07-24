/**
 * Shared process and git helpers for CLI executors.
 *
 * The Kiro, Copilot, and Claude executors all follow the same pattern:
 * spawn the CLI in a new process group with a timeout, stream stdout/stderr
 * to a session log, and verify success by checking whether new commits were
 * pushed to the remote branch (the CLI is responsible for all git operations).
 *
 * This module centralizes that shared logic so each executor only differs in
 * which command, arguments, and environment it spawns.
 */

import { execFile as execFileCb, spawn } from 'node:child_process'
import { promisify } from 'node:util'

import type pino from 'pino'

import type { SessionHandle } from '../components/session-log-writer'

const execFile = promisify(execFileCb)

// ── Types ───────────────────────────────────────────────────────────

/**
 * Result from spawnWithProcessGroupTimeout.
 */
export interface SpawnResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
}

// ── Process spawning ────────────────────────────────────────────────

/**
 * Spawns a child process in a new process group and enforces a timeout
 * by killing the entire process group (SIGKILL to -pid).
 *
 * This prevents orphaned grandchild processes from lingering after a
 * timeout, which was causing the parent Node.js process to be OOM-killed
 * (exit code 137).
 */
export const spawnWithProcessGroupTimeout = (
  command: string,
  args: string[],
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
    timeoutMs: number
    maxBuffer: number
  },
  log: pino.Logger,
  sessionHandle?: SessionHandle,
): Promise<SpawnResult> =>
  new Promise((resolve, reject) => {
    const { cwd, env, timeoutMs, maxBuffer } = options

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const child = spawn(command, args, {
      cwd,
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
      log.warn({ pid: child.pid, timeoutMs }, 'Timeout reached, killing process group')
      killProcessGroup()
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      if (stdout.length < maxBuffer) {
        stdout += text
      }
      // Pipe to session handle for real-time logging
      if (sessionHandle != null) {
        sessionHandle.writeStdout(text)
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      if (stderr.length < maxBuffer) {
        stderr += text
      }
      // Pipe to session handle for real-time logging
      if (sessionHandle != null) {
        sessionHandle.writeStderr(text)
      }
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

// ── Git helpers ─────────────────────────────────────────────────────

/**
 * Gets the current branch name from the working directory.
 */
export const getCurrentBranch = async (
  workingDir: string,
  log: pino.Logger,
): Promise<string | null> => {
  try {
    const { stdout } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: workingDir,
    })
    const branch = stdout.trim()
    log.info({ branch }, 'Detected current branch')
    return branch || null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn({ error: message }, 'Failed to detect current branch')
    return null
  }
}

/**
 * Gets the current HEAD SHA of a remote branch (origin/{branch}).
 * Returns null if the remote branch does not exist yet.
 */
export const getRemoteHeadSha = async (
  workingDir: string,
  branchName: string,
  log: pino.Logger,
): Promise<string | null> => {
  try {
    const { stdout } = await execFile('git', ['rev-parse', `origin/${branchName}`], {
      cwd: workingDir,
    })
    const sha = stdout.trim()
    log.info({ sha, branch: branchName }, 'Recorded pre-execution remote HEAD')
    return sha || null
  } catch {
    // Remote branch may not exist yet (e.g., new issue branch)
    log.info({ branch: branchName }, 'Remote branch does not exist yet (new branch expected)')
    return null
  }
}

/**
 * Verifies that the CLI pushed new commits to the remote branch by
 * fetching from origin and comparing the remote HEAD SHA against the
 * pre-execution state.
 *
 * Returns true when:
 * - The remote branch now exists but did not before (new branch pushed)
 * - The remote branch HEAD has advanced beyond the pre-execution SHA
 */
export const verifyPushedCommits = async (
  workingDir: string,
  branchName: string | null,
  preExecSha: string | null,
  log: pino.Logger,
): Promise<boolean> => {
  if (!branchName) {
    log.warn('No branch name available; cannot verify pushed commits')
    return false
  }

  try {
    // Fetch latest state from origin
    await execFile('git', ['fetch', 'origin'], { cwd: workingDir })

    // Get the post-fetch remote HEAD SHA
    let postExecSha: string | null = null
    try {
      const { stdout } = await execFile('git', ['rev-parse', `origin/${branchName}`], {
        cwd: workingDir,
      })
      postExecSha = stdout.trim() || null
    } catch {
      // Remote branch still does not exist after fetch
      postExecSha = null
    }

    if (postExecSha == null) {
      log.info(
        { branch: branchName },
        'Remote branch does not exist after fetch; no commits pushed',
      )
      return false
    }

    if (preExecSha == null) {
      // Branch did not exist before but exists now — new commits were pushed
      log.info({ branch: branchName, postExecSha }, 'Remote branch created with new commits')
      return true
    }

    if (postExecSha !== preExecSha) {
      log.info(
        { branch: branchName, preExecSha, postExecSha },
        'Remote branch advanced; new commits detected',
      )
      return true
    }

    log.info({ branch: branchName }, 'No new commits pushed to remote branch')
    return false
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn({ error: message }, 'Failed to verify pushed commits; assuming no changes')
    return false
  }
}
