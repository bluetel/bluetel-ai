/**
 * Bootstrap phase 7 — start the agent (T055's other half).
 *
 * This module exists to be the **only** place bootstrap calls
 * `AgentAdapter.start`, and to make that call impossible without evidence that
 * phase 6 finished. It takes a {@link ReadyWorkspace}, which `workspace.ts`
 * alone can construct and only from a checkout in which every entry succeeded,
 * and it derives the agent's working directory and config directory from that
 * value rather than from anything a caller passes in.
 *
 * The result is that "the agent never starts against an incomplete workspace"
 * (FR-112) is enforced by the type checker rather than by review. A caller
 * holding a list of entries, a root path, or a half-finished checkout has
 * nothing that fits this signature.
 *
 * Deriving `cwd` from the workspace also settles FR-113 in the same stroke: the
 * agent's working directory is the workspace root, so one session reads and
 * changes files across every entry, and there is no parameter to get wrong.
 */

import { stat } from 'node:fs/promises'

import type { AgentAdapter } from '../agent'

import { BootstrapPhaseError, runPhase } from './phases'
import type { BootstrapPhaseReporter, RunPhaseContext } from './phases'
import type { ReadyWorkspace } from './workspace'

export interface StartAgentOptions {
  readonly adapter: AgentAdapter
  /** Only obtainable from a fully successful phase 6. */
  readonly workspace: ReadyWorkspace
  /** Platform-assigned, so the run is addressable even if it dies (FR-052). */
  readonly sessionId: string
  readonly model: string
  /** Fully assembled upstream; the executor never assembles a prompt. */
  readonly prompt: string
  readonly turnCap?: number
  readonly spendCapUsd?: number
  /** Restore path only, and the **snapshot's** session id (FR-150). */
  readonly resumeSessionId?: string
  readonly reporter: BootstrapPhaseReporter
  readonly timeoutMs?: number
  readonly now?: () => number
}

export interface StartedAgent {
  readonly adapter: AgentAdapter
  readonly cwd: string
  readonly configDir: string
  readonly sessionId: string
}

export const startAgentPhase = async (options: StartAgentOptions): Promise<StartedAgent> => {
  const context: RunPhaseContext = {
    reporter: options.reporter,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  }

  return runPhase(
    'agent_start',
    async (): Promise<StartedAgent> => {
      /*
       * The one-line check spike S2 asked for.
       *
       * S2 placed the agent config tree inside the pinned root by construction
       * and recorded that `CLAUDE_CONFIG_DIR` actually relocating it was
       * assumed rather than shown. This asserts the half that is ours to
       * assert — the directory we point the variable at exists — so a missing
       * config tree fails here, naming `agent_start`, instead of surfacing much
       * later as a snapshot with no conversation state in it (FR-051, FR-050).
       * Whether the real CLI honours the variable is still unobserved and is
       * settled by the first real invocation, not by this check.
       */
      const configDir = await stat(options.workspace.configDir).catch(() => undefined)

      if (configDir?.isDirectory() !== true) {
        throw new BootstrapPhaseError(
          'agent_start',
          `the relocated agent config directory ${options.workspace.configDir} is missing; ` +
            'conversation state would not be inside the snapshot target (FR-051)',
          { retryable: false },
        )
      }

      await options.adapter.start({
        sessionId: options.sessionId,
        // Derived, never passed: the workspace root is the working directory.
        cwd: options.workspace.root,
        configDir: options.workspace.configDir,
        model: options.model,
        prompt: options.prompt,
        ...(options.turnCap === undefined ? {} : { turnCap: options.turnCap }),
        ...(options.spendCapUsd === undefined ? {} : { spendCapUsd: options.spendCapUsd }),
        ...(options.resumeSessionId === undefined
          ? {}
          : { resumeSessionId: options.resumeSessionId }),
      })

      return {
        adapter: options.adapter,
        cwd: options.workspace.root,
        configDir: options.workspace.configDir,
        sessionId: options.sessionId,
      }
    },
    context,
  )
}
