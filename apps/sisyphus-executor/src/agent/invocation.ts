/**
 * How the agent process is invoked (T056).
 *
 * Separated from `cli-stream.ts` so the flag list is a pure function of the
 * start options and can be asserted directly. It is worth asserting: three of
 * these flags are load-bearing constraints recovered from the shipped binary's
 * own error strings during spike S1, not preferences —
 * `--input-format stream-json` requires `--print`, requires
 * `--output-format stream-json`, and that in turn requires `--verbose`. Drop
 * any one and the CLI refuses to start, on a paid instance, after bootstrap has
 * already run.
 *
 * Keeping it separate is also what lets T057 drive the adapter against the stub
 * agent process: the adapter takes a {@link AgentProcessSpecFactory}, so the
 * integration test substitutes the spawn target without the adapter growing a
 * test-only branch.
 */

import type { AgentStartOptions } from './adapter'

/** The command and arguments to spawn, and the environment to spawn it with. */
export interface AgentProcessSpec {
  readonly command: string
  readonly args: readonly string[]
  /** Merged over the executor's own environment by the adapter. */
  readonly env: Readonly<Record<string, string>>
}

export type AgentProcessSpecFactory = (options: AgentStartOptions) => AgentProcessSpec

/** Resolved from `PATH`; the setup bundle is what put it there (FR-043). */
export const CLAUDE_COMMAND = 'claude'

/**
 * Flags for one invocation.
 *
 * `--resume` appears only when {@link AgentStartOptions.resumeSessionId} is
 * set, and it carries the identifier recorded **in the snapshot** rather than
 * the run's own — for a successor created by `continueWithChanges` those differ,
 * and conflating them makes the resume fail by finding nothing (FR-150).
 */
export const buildClaudeArgs = (options: AgentStartOptions): readonly string[] => {
  const args = [
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    // Required by `--output-format stream-json`; not a debugging aid.
    '--verbose',
    // The acknowledgement channel. Without it `sendTurn` can report that a
    // write succeeded but never that the agent received it (FR-049).
    '--replay-user-messages',
    '--session-id',
    options.sessionId,
    '--model',
    options.model,
    // The instance exists to run one workflow unattended and is destroyed
    // afterwards; a permission prompt has nobody to answer it.
    '--permission-mode',
    'bypassPermissions',
  ]

  if (options.turnCap !== undefined) {
    // A second line only. The first is the local enforcer in `caps/`, which is
    // also the only one of the two that knows anything about spend.
    args.push('--max-turns', String(options.turnCap))
  }

  if (options.resumeSessionId !== undefined) {
    args.push('--resume', options.resumeSessionId)
  }

  return args
}

/**
 * Environment for the agent process.
 *
 * `CLAUDE_CONFIG_DIR` is the whole point. R2 relocates the config tree inside
 * the pinned workspace root so the conversation state and the working trees are
 * a single tar target (FR-051); spike S2 placed that tree there by construction
 * and recorded that the variable actually relocating it was **assumed, not
 * shown**. Setting it here is the assumption made explicit in one place, so the
 * first real invocation either confirms it or has one line to correct.
 */
export const buildClaudeEnv = (options: AgentStartOptions): Readonly<Record<string, string>> =>
  options.configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: options.configDir }

export const claudeProcessSpec: AgentProcessSpecFactory = (options) => ({
  command: CLAUDE_COMMAND,
  args: buildClaudeArgs(options),
  env: buildClaudeEnv(options),
})
