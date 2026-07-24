/**
 * A2A task handler for orchestrating task execution.
 *
 * Parses and validates A2A task input, then executes the full pipeline:
 * clone repository → run install script (optional) → invoke CLI executor
 * (via Executor_Router) → report results via the task store.
 *
 * Does NOT use Issue_Commenter, does NOT append automated instructions
 * to the caller's prompt, and does NOT look for `rocky.sh`.
 */

import { spawn } from 'node:child_process'
import { unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type pino from 'pino'

import type {
  A2ATask,
  A2ATaskHandler,
  A2ATaskInput,
  A2ATaskMessage,
  A2ATaskStore,
  A2AValidationError,
  AuthResult,
  CloneResult,
  ExecutionResult,
  RepoClonerA2A,
  WorkerConfig,
} from '../lib/a2a-types'
import { buildA2APrompt, buildSetupPrompt } from '../lib/prompt-builder'
import type { Engine } from '../lib/types'

import type {
  SessionHandle,
  SessionLogContext,
  SessionLogWriterInstance,
} from './session-log-writer'
import { generatePromptSummary, generateResultSummary, type SummarizerInstance } from './summarizer'

// ── Constants ───────────────────────────────────────────────────────

const INSTALL_SCRIPT_FILENAME = 'rocky-install.sh'

/**
 * Regex for validating GitHub HTTPS repository URLs.
 * Matches `https://github.com/{owner}/{repo}` with optional `.git` suffix.
 */
const GITHUB_REPO_URL_REGEX =
  /^https:\/\/github\.com\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+?)(?:\.git)?$/

/**
 * Regex for validating git branch ref characters.
 * Allows alphanumeric, `-`, `_`, `/`, `.` characters.
 */
const GIT_REF_REGEX = /^[a-zA-Z0-9\-_/.]+$/

// ── Input Parsing ───────────────────────────────────────────────────

/**
 * Parses and validates A2A task input from a task message.
 *
 * Extracts `repoUrl`, `baseBranch`, `installScript`, and `prompt` from
 * the first text part of the message. Returns a validated `A2ATaskInput`
 * or an `A2AValidationError` with field-specific details.
 *
 * @internal Exported for testing.
 */
export const parseTaskInput = (message: A2ATaskMessage): A2ATaskInput | A2AValidationError => {
  // Extract the first text part from the message
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime validation of untrusted input
  const textPart = message.parts.find((p) => p.type === 'text')
  if (textPart == null) {
    return { valid: false, field: 'message', message: 'No text part found in message' }
  }

  // Parse the JSON content
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(textPart.text) as Record<string, unknown>
  } catch {
    return { valid: false, field: 'message', message: 'Invalid JSON in message text' }
  }

  // Validate repoUrl
  const repoUrl = parsed['repoUrl']
  if (typeof repoUrl !== 'string' || repoUrl.length === 0) {
    return {
      valid: false,
      field: 'repoUrl',
      message: 'repoUrl is required and must be a non-empty string',
    }
  }
  if (!GITHUB_REPO_URL_REGEX.test(repoUrl)) {
    return {
      valid: false,
      field: 'repoUrl',
      message: 'repoUrl must match https://github.com/{owner}/{repo} (with optional .git suffix)',
    }
  }

  // Validate baseBranch
  const baseBranch = parsed['baseBranch']
  if (typeof baseBranch !== 'string' || baseBranch.length === 0) {
    return {
      valid: false,
      field: 'baseBranch',
      message: 'baseBranch is required and must be a non-empty string',
    }
  }
  if (!GIT_REF_REGEX.test(baseBranch)) {
    return {
      valid: false,
      field: 'baseBranch',
      message: 'baseBranch contains invalid characters (allowed: alphanumeric, -, _, /, .)',
    }
  }

  // Validate prompt
  const prompt = parsed['prompt']
  if (typeof prompt !== 'string' || prompt.length === 0) {
    return {
      valid: false,
      field: 'prompt',
      message: 'prompt is required and must be a non-empty string',
    }
  }

  // installScript is optional
  const installScript = parsed['installScript']
  if (installScript != null && typeof installScript !== 'string') {
    return {
      valid: false,
      field: 'installScript',
      message: 'installScript must be a string if provided',
    }
  }

  // engine is optional — validate if present
  const engine = parsed['engine']
  if (engine != null && engine !== 'kiro' && engine !== 'copilot' && engine !== 'claude') {
    return {
      valid: false,
      field: 'engine',
      message: 'engine must be "kiro", "copilot", or "claude" if provided',
    }
  }

  // agent is optional — validate if present
  const agent = parsed['agent']
  if (agent != null && (typeof agent !== 'string' || agent.length === 0)) {
    return {
      valid: false,
      field: 'agent',
      message: 'agent must be a non-empty string if provided',
    }
  }

  return {
    repoUrl: repoUrl,
    baseBranch: baseBranch,
    prompt: prompt,
    ...(typeof installScript === 'string' && installScript.length > 0 ? { installScript } : {}),
    ...(engine === 'kiro' || engine === 'copilot' || engine === 'claude' ? { engine } : {}),
    ...(typeof agent === 'string' && agent.length > 0 ? { agent } : {}),
  }
}

/**
 * Extracts `owner/repo` from a validated GitHub repository URL.
 *
 * @internal Exported for testing.
 */
export const extractRepoFullName = (repoUrl: string): string => {
  const match = GITHUB_REPO_URL_REGEX.exec(repoUrl)
  if (match == null) {
    throw new Error(`Invalid GitHub URL: ${repoUrl}`)
  }
  return `${match[1]}/${match[2]}`
}

// ── Type Guards ─────────────────────────────────────────────────────

/**
 * Type guard to distinguish A2AValidationError from A2ATaskInput.
 */
export const isValidationError = (
  result: A2ATaskInput | A2AValidationError,
): result is A2AValidationError => 'valid' in result && !result.valid

// ── Helpers ─────────────────────────────────────────────────────────

// ── Dependencies ────────────────────────────────────────────────────

interface ExecutorRouterInstance {
  execute: (
    workingDir: string,
    prompt: string,
    options?: { engine?: Engine; agent?: string; context?: SessionLogContext },
  ) => Promise<ExecutionResult>
}

interface JobQueueInstance {
  removeJob?: (jobId: string) => boolean
}

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Creates an A2A task handler bound to the given dependencies.
 *
 * @param deps - Shared components: repoCloner, executorRouter, taskStore,
 *   jobQueue, authResult, config, logger
 * @returns A2ATaskHandler with parseTaskInput, executeTask, and cancelTask
 */
export const createA2ATaskHandler = (deps: {
  repoCloner: RepoClonerA2A
  executorRouter: ExecutorRouterInstance
  sessionLogWriter: SessionLogWriterInstance
  taskStore: A2ATaskStore
  jobQueue: JobQueueInstance
  authResult: AuthResult
  config: WorkerConfig
  logger: pino.Logger
  summarizer: SummarizerInstance
}): A2ATaskHandler => {
  const {
    repoCloner,
    executorRouter,
    sessionLogWriter,
    taskStore,
    authResult,
    config,
    logger,
    summarizer,
  } = deps

  /** Track active child processes for cancellation support. */
  const activeControllers = new Map<string, AbortController>()

  const executeTask = async (task: A2ATask): Promise<void> => {
    const log = logger.child({
      taskId: task.id,
      repo: task.repoFullName,
      component: 'a2a-task-handler',
    })
    let workingDir: string | undefined

    try {
      // 1. Update status to working
      taskStore.updateStatus(task.id, 'working')
      log.info('A2A task execution started')

      // Fire-and-forget — does not block execution pipeline
      void generatePromptSummary(task, summarizer, taskStore, log)

      // 2. Clone repository at baseBranch
      log.info({ baseBranch: task.input.baseBranch }, 'Cloning repository')
      let cloneResult: CloneResult
      try {
        const token = await authResult.getCloneToken()
        cloneResult = await repoCloner.cloneAtBranch(
          task.repoFullName,
          task.input.baseBranch,
          token,
        )
        workingDir = cloneResult.workingDir
        log.info({ workingDir }, 'Repository cloned successfully')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.error({ error: message }, 'Clone failed')
        taskStore.setError(task.id, 'clone', message)
        await generateResultSummary(task, summarizer, taskStore, log)
        taskStore.updateStatus(task.id, 'failed')
        return
      }

      // 3. Run install script if provided, otherwise run setup execution
      if (task.input.installScript != null && task.input.installScript.length > 0) {
        log.debug('installScript provided, skipping setup execution')
        log.info('Running install script')

        // Create a session handle so install script output is logged the same
        // way as LLM-driven setup (streamed to a session log file).
        const setupContext: SessionLogContext = {
          engine: task.input.engine ?? config.defaultEngine,
          repoFullName: task.repoFullName,
          executionContext: `setup-task-${task.id}`,
        }
        let sessionHandle: SessionHandle | undefined
        try {
          sessionHandle = sessionLogWriter.createSession(setupContext)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.warn(
            { error: message },
            'Failed to create session handle for install script: %s',
            message,
          )
        }

        try {
          await runInstallScript(
            task.id,
            workingDir,
            task.input.installScript,
            config.setupScriptTimeoutMs,
            taskStore,
            activeControllers,
            log,
            sessionHandle,
          )
          log.info('Install script completed successfully')
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          log.error({ error: message }, 'Install script failed')
          taskStore.setError(task.id, 'install', message)
          await generateResultSummary(task, summarizer, taskStore, log)
          taskStore.updateStatus(task.id, 'failed')
          return
        }
      } else {
        log.info('No installScript provided, running setup execution')
        const setupPrompt = buildSetupPrompt()
        const setupResult = await executorRouter.execute(workingDir, setupPrompt, {
          engine: task.input.engine,
          agent: task.input.agent ?? config.defaultAgent,
          context: {
            engine: task.input.engine ?? config.defaultEngine,
            repoFullName: task.repoFullName,
            executionContext: `setup-task-${task.id}`,
          },
        })
        if (!setupResult.success) {
          const message = setupResult.stderr
            ? `Exit code ${String(setupResult.exitCode)}: ${setupResult.stderr.slice(0, 1000)}`
            : `Setup execution exited with code ${String(setupResult.exitCode)}`
          log.error({ exitCode: setupResult.exitCode }, 'Setup execution failed')
          taskStore.setError(task.id, 'setup', message)
          await generateResultSummary(task, summarizer, taskStore, log)
          taskStore.updateStatus(task.id, 'failed')
          return
        }
        if (setupResult.stdout) {
          taskStore.addArtifact(task.id, {
            type: 'setup_output',
            value: setupResult.stdout.slice(0, 5000),
          })
        }
        log.info('Setup execution completed successfully')
      }

      // 4. Wrap caller's prompt with system preamble and pass to the selected executor
      log.info('Invoking CLI executor')
      let result: ExecutionResult
      try {
        const fullPrompt = buildA2APrompt(task.input.prompt)
        result = await executorRouter.execute(workingDir, fullPrompt, {
          engine: task.input.engine,
          agent: task.input.agent ?? config.defaultAgent,
          context: {
            engine: task.input.engine ?? config.defaultEngine,
            repoFullName: task.repoFullName,
            executionContext: `task-${task.id}`,
          },
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.error({ error: message }, 'CLI execution failed')
        taskStore.setError(task.id, 'kiro-cli', message)
        await generateResultSummary(task, summarizer, taskStore, log)
        taskStore.updateStatus(task.id, 'failed')
        return
      }

      // 5. Process result
      if (!result.success) {
        const message = result.stderr
          ? `Exit code ${String(result.exitCode)}: ${result.stderr.slice(0, 1000)}`
          : `CLI exited with code ${String(result.exitCode)}`
        log.error({ exitCode: result.exitCode }, 'CLI returned failure')
        taskStore.setError(task.id, 'kiro-cli', message)
        await generateResultSummary(task, summarizer, taskStore, log)
        taskStore.updateStatus(task.id, 'failed')
        return
      }

      // 6. On success: add artifacts and mark completed
      if (result.stdout) {
        taskStore.addArtifact(task.id, {
          type: 'stdout',
          value: result.stdout.slice(0, 5000),
        })
      }

      if (result.hasChanges) {
        taskStore.addArtifact(task.id, {
          type: 'branch',
          value: 'Changes pushed to remote',
        })
      }

      // Inline — blocks briefly (max 30s) to ensure summary is available before completion
      await generateResultSummary(task, summarizer, taskStore, log)
      taskStore.setCompleted(task.id)
      log.info('A2A task completed successfully')
    } catch (error) {
      // Catch-all for unexpected errors
      const message = error instanceof Error ? error.message : String(error)
      log.error({ error: message }, 'Unexpected error during A2A task execution')
      taskStore.setError(task.id, 'kiro-cli', message)
      await generateResultSummary(task, summarizer, taskStore, log)
      taskStore.updateStatus(task.id, 'failed')
    } finally {
      // 7. Always clean up working directory
      activeControllers.delete(task.id)
      if (workingDir) {
        try {
          await repoCloner.cleanup(workingDir)
          log.info({ workingDir }, 'Working directory cleaned up')
        } catch (cleanupError) {
          const message =
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          log.warn({ error: message }, 'Failed to clean up working directory')
        }
      }
    }
  }

  const cancelTask = (taskId: string): Promise<boolean> => {
    const log = logger.child({ taskId, component: 'a2a-task-handler' })
    const task = taskStore.get(taskId)

    if (task == null) {
      log.warn('Cancel requested for unknown task')
      return Promise.resolve(false)
    }

    switch (task.status) {
      case 'submitted': {
        // Remove from queue — task hasn't started yet
        taskStore.updateStatus(taskId, 'canceled')
        log.info('Canceled submitted task')
        return Promise.resolve(true)
      }

      case 'working': {
        // Kill the active child process if one exists
        const controller = activeControllers.get(taskId)
        if (controller) {
          controller.abort()
          activeControllers.delete(taskId)
        }
        taskStore.updateStatus(taskId, 'canceled')
        log.info('Canceled working task')
        return Promise.resolve(true)
      }

      case 'completed':
      case 'failed':
      case 'canceled': {
        // No-op for terminal states
        log.info({ status: task.status }, 'Cancel requested for task in terminal state')
        return Promise.resolve(false)
      }

      default:
        return Promise.resolve(false)
    }
  }

  return {
    parseTaskInput,
    executeTask,
    cancelTask,
  }
}

// ── Install Script Runner ───────────────────────────────────────────

/**
 * Writes the install script to disk and executes it with bash, streaming
 * stdout/stderr to a SessionHandle so that install script output appears
 * in session logs in the same format as LLM-driven setup.
 *
 * Enforces a timeout by killing the process group. Registers an
 * AbortController in the activeControllers map for cancellation support.
 */
const runInstallScript = async (
  taskId: string,
  workingDir: string,
  scriptContent: string,
  timeoutMs: number,
  taskStore: A2ATaskStore,
  activeControllers: Map<string, AbortController>,
  log: pino.Logger,
  sessionHandle?: SessionHandle,
): Promise<void> => {
  const scriptPath = path.join(workingDir, INSTALL_SCRIPT_FILENAME)

  // Write the install script to disk
  await writeFile(scriptPath, scriptContent, { mode: 0o755 })

  // Write a prompt section to the session log so it mirrors LLM setup logs
  if (sessionHandle != null) {
    sessionHandle.writeSetupScript(scriptContent)
  }

  const controller = new AbortController()
  activeControllers.set(taskId, controller)

  return new Promise<void>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const child = spawn('bash', [INSTALL_SCRIPT_FILENAME], {
      cwd: workingDir,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const killProcessGroup = (): void => {
      if (child.pid == null) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // Process group may already be dead
      }
    }

    const timeout = setTimeout(() => {
      timedOut = true
      killProcessGroup()
    }, timeoutMs)

    // Handle abort from cancellation
    const onAbort = (): void => {
      timedOut = true
      killProcessGroup()
    }
    controller.signal.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stdout += text
      if (sessionHandle != null) {
        sessionHandle.writeStdout(text)
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr += text
      if (sessionHandle != null) {
        sessionHandle.writeStderr(text)
      }
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      controller.signal.removeEventListener('abort', onAbort)

      const result: ExecutionResult = {
        success: false,
        hasChanges: false,
        stdout,
        stderr,
        exitCode: null,
      }
      if (sessionHandle != null) {
        sessionHandle.finalize(result).catch(() => {})
      }

      reject(err)
    })

    child.on('close', (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      controller.signal.removeEventListener('abort', onAbort)

      const success = exitCode === 0
      const result: ExecutionResult = {
        success,
        hasChanges: false,
        stdout,
        stderr,
        exitCode,
      }

      void (async () => {
        // Finalize session log
        if (sessionHandle != null) {
          try {
            await sessionHandle.finalize(result)
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            log.warn({ error: message }, 'Failed to finalize install script session log')
          }
        }

        // Capture output as artifact
        if (stdout) {
          taskStore.addArtifact(taskId, {
            type: 'install_output',
            value: stdout.slice(0, 5000),
          })
        }

        // Delete the install script so it doesn't accidentally get committed
        try {
          await unlink(scriptPath)
        } catch {
          log.warn({ scriptPath }, 'Failed to delete install script after execution')
        }

        if (timedOut) {
          reject(new Error(`Install script timed out after ${timeoutMs}ms`))
          return
        }

        if (!success) {
          const message = `Exit code ${String(exitCode)}: ${stderr.slice(0, 500)}`
          log.error({ exitCode, stderr: stderr.slice(0, 500) }, 'Install script failed')
          reject(new Error(message))
          return
        }

        resolve()
      })()
    })
  })
}
