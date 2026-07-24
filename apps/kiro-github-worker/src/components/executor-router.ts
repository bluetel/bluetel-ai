/**
 * Executor router for engine selection.
 *
 * A thin routing layer that selects the appropriate executor (Kiro or
 * Copilot) based on a configured default engine and an optional per-task
 * engine override. All callers (webhook handlers, A2A_Task_Handler,
 * MCP_Task_Handler) use the router instead of calling executors directly.
 *
 * Factory function `createExecutorRouter` returns an `execute` function
 * bound to the given config, executors, and logger.
 */

import type pino from 'pino'

import type { Engine, ExecutionResult } from '../lib/types'

import type {
  SessionHandle,
  SessionLogContext,
  SessionLogWriterInstance,
} from './session-log-writer'

// ── Types ───────────────────────────────────────────────────────────

export type { Engine }

export interface ExecutorRouterConfig {
  defaultEngine: Engine
}

export interface ExecutorInstance {
  execute: (
    workingDir: string,
    prompt: string,
    options?: { sessionHandle?: SessionHandle; agent?: string },
  ) => Promise<ExecutionResult>
}

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Creates an executor router that selects the appropriate engine for
 * each execution request.
 *
 * @param config - Router configuration with the default engine
 * @param deps - Dependencies: kiro executor, optional copilot executor, session log writer, and logger
 * @returns Object with an `execute` function that routes to the correct executor
 */
export const createExecutorRouter = (
  config: ExecutorRouterConfig,
  deps: {
    kiroExecutor: ExecutorInstance
    copilotExecutor: ExecutorInstance | null
    claudeExecutor: ExecutorInstance | null
    sessionLogWriter: SessionLogWriterInstance
    logger: pino.Logger
  },
): {
  execute: (
    workingDir: string,
    prompt: string,
    options?: { engine?: Engine; agent?: string; context?: SessionLogContext },
  ) => Promise<ExecutionResult>
} => {
  const { kiroExecutor, copilotExecutor, claudeExecutor, sessionLogWriter, logger } = deps

  /**
   * Selects the target engine and delegates to the matching executor.
   *
   * @param workingDir - The cloned repository working directory
   * @param prompt - The prompt for the CLI engine
   * @param options - Optional per-task engine override, agent selection, and session log context
   * @returns ExecutionResult from the selected executor
   */
  const execute = async (
    workingDir: string,
    prompt: string,
    options?: { engine?: Engine; agent?: string; context?: SessionLogContext },
  ): Promise<ExecutionResult> => {
    const targetEngine = options?.engine ?? config.defaultEngine

    if (targetEngine === 'copilot' && copilotExecutor == null) {
      return {
        success: false,
        hasChanges: false,
        stdout: '',
        stderr: 'Copilot engine is not available — COPILOT_CLI_PATH is not configured',
        exitCode: null,
      }
    }

    if (targetEngine === 'claude' && claudeExecutor == null) {
      return {
        success: false,
        hasChanges: false,
        stdout: '',
        stderr: 'Claude engine is not available — CLAUDE_CLI_PATH is not configured',
        exitCode: null,
      }
    }

    logger.info({ engine: targetEngine }, 'Selected engine: %s', targetEngine)

    // Resolve agent — only applicable for kiro engine
    let resolvedAgent: string | undefined
    if (options?.agent) {
      if (targetEngine === 'kiro') {
        resolvedAgent = options.agent
      } else {
        logger.debug(
          { engine: targetEngine },
          'Agent selection ignored: only supported for kiro engine',
        )
      }
    }

    // Safe: copilot/claude paths are guarded by the null checks above
    const executor =
      targetEngine === 'copilot'
        ? (copilotExecutor as ExecutorInstance)
        : targetEngine === 'claude'
          ? (claudeExecutor as ExecutorInstance)
          : kiroExecutor

    // Create streaming session handle if context available
    let sessionHandle: SessionHandle | undefined
    if (options?.context != null) {
      try {
        sessionHandle = sessionLogWriter.createSession({
          ...options.context,
          engine: targetEngine,
          agent: resolvedAgent,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.warn({ error: message }, 'Failed to create session handle: %s', message)
      }
    }

    // Write prompt to session log before calling executor
    if (sessionHandle != null) {
      try {
        sessionHandle.writePrompt(prompt)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.warn({ error: message }, 'Failed to write prompt to session log: %s', message)
      }
    }

    const result = await executor.execute(workingDir, prompt, {
      sessionHandle,
      agent: resolvedAgent,
    })

    // Finalize session log
    if (sessionHandle != null) {
      try {
        await sessionHandle.finalize(result)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.warn({ error: message }, 'Session log finalize failed: %s', message)
      }
    }

    return result
  }

  return { execute }
}
