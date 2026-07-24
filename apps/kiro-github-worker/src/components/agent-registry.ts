/**
 * Agent Registry — discovers and caches available Kiro CLI agents.
 *
 * Invokes `kiro-cli agent` to list agents, parses the tabular output,
 * and provides lookup/refresh methods for other components.
 */

import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'

import type pino from 'pino'

const execFile = promisify(execFileCb)

// ── Types ───────────────────────────────────────────────────────────

export interface Agent {
  name: string
  scope: 'builtin' | 'global' | 'workspace'
  description: string
  isDefault: boolean
}

export interface AgentRegistryState {
  agents: Agent[]
  discoveredAt: string | null
}

export interface AgentRegistry {
  getAgents(): Agent[]
  getAgent(name: string): Agent | undefined
  refresh(): Promise<Agent[]>
  getState(): AgentRegistryState
}

export interface AgentRegistryConfig {
  kiroCliPath: string
  timeoutMs?: number
}

// ── Parser ──────────────────────────────────────────────────────────

/**
 * Parses the tabular stdout output of `kiro-cli agent`.
 *
 * Expected format:
 * ```
 * * kiro_default            (Built-in)    Default agent
 *   kiro_help               (Built-in)    Help agent that answers questions...
 *   spec-orchestrator       (Global)      Orchestrates spec-driven development...
 *                                          It selects the workflow type and delegates...
 * ```
 */
export const parseAgentOutput = (stdout: string): Agent[] => {
  const agents: Agent[] = []
  const lines = stdout.split('\n')

  // Regex to match an agent entry line:
  // Optional `*` or space at start, then name, then scope in parens or bare, then description
  const entryRegex = /^([* ])\s+(\S+)\s+\(?(Built-in|Global|Workspace)\)?\s*(.*?)\s*$/

  let currentAgent: Agent | null = null

  for (const line of lines) {
    const match = entryRegex.exec(line)
    if (match) {
      // Save previous agent
      if (currentAgent) agents.push(currentAgent)

      const isDefault = match[1] === '*'
      const name = match[2]
      const rawScope = match[3]
      const description = match[4]

      const scope = normalizeScope(rawScope)

      currentAgent = { name, scope, description, isDefault }
    } else if (currentAgent && line.length > 0 && /^\s{2,}/.test(line)) {
      // Continuation line — append to current agent's description
      const continuation = line.trim()
      if (continuation) {
        currentAgent.description += ' ' + continuation
      }
    }
  }

  // Push the last agent
  if (currentAgent) agents.push(currentAgent)

  // Ensure exactly one default
  applyDefaultFallback(agents)

  return agents
}

const normalizeScope = (raw: string): 'builtin' | 'global' | 'workspace' => {
  switch (raw) {
    case 'Built-in':
      return 'builtin'
    case 'Global':
      return 'global'
    case 'Workspace':
      return 'workspace'
    default:
      return 'global'
  }
}

/**
 * If no agent is marked as default, apply fallback logic:
 * use `kiro_default` if present, otherwise the first agent.
 */
const applyDefaultFallback = (agents: Agent[]): void => {
  if (agents.length === 0) return
  const hasDefault = agents.some((a) => a.isDefault)
  if (hasDefault) return

  const kiroDefault = agents.find((a) => a.name === 'kiro_default')
  if (kiroDefault) {
    kiroDefault.isDefault = true
  } else {
    agents[0].isDefault = true
  }
}

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Creates an Agent Registry that discovers and caches Kiro CLI agents.
 *
 * Discovery runs immediately (non-blocking) and can be triggered again
 * via `refresh()`. The registry is usable with an empty list before
 * discovery completes.
 */
export const createAgentRegistry = (
  config: AgentRegistryConfig,
  logger: pino.Logger,
): AgentRegistry => {
  const timeoutMs = config.timeoutMs ?? 10_000
  let state: AgentRegistryState = { agents: [], discoveredAt: null }

  const discover = async (): Promise<Agent[]> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const { stdout, stderr } = await execFile(config.kiroCliPath, ['agent'], {
        timeout: timeoutMs,
        signal: controller.signal,
      })
      clearTimeout(timer)

      // kiro-cli writes to stderr when stdout is not a TTY (non-interactive)
      const output = stdout.trim() !== '' ? stdout : stderr
      const agents = parseAgentOutput(output)
      state = { agents, discoveredAt: new Date().toISOString() }

      const breakdown = agents.reduce(
        (acc, a) => {
          acc[a.scope]++
          return acc
        },
        { builtin: 0, global: 0, workspace: 0 },
      )

      logger.info(
        { total: agents.length, ...breakdown },
        'Discovered %d agents: %d built-in, %d global, %d workspace',
        agents.length,
        breakdown.builtin,
        breakdown.global,
        breakdown.workspace,
      )

      return agents
    } catch (error: unknown) {
      clearTimeout(timer)

      if (error instanceof Error && error.name === 'AbortError') {
        logger.warn('Agent discovery timed out after %dms', timeoutMs)
      } else {
        const message = error instanceof Error ? error.message : String(error)
        const stderr = (error as { stderr?: string }).stderr
        logger.warn({ error: message, stderr }, 'Agent discovery failed')
      }

      return state.agents
    }
  }

  // Fire-and-forget initial discovery
  void discover()

  return {
    getAgents: (): Agent[] => state.agents,

    getAgent: (name: string): Agent | undefined => state.agents.find((a) => a.name === name),

    refresh: async (): Promise<Agent[]> => {
      const previousAgents = state.agents
      const previousDiscoveredAt = state.discoveredAt

      const agents = await discover()

      // If discover() failed, state.agents won't have changed (discover preserves on failure)
      // But if the discover function itself threw before updating state, we restore here
      if (state.agents === previousAgents && state.discoveredAt === previousDiscoveredAt) {
        // discover() didn't update state — failure case, state already preserved
      }

      return agents
    },

    getState: (): AgentRegistryState => ({ ...state }),
  }
}
