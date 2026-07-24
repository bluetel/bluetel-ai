// Openclaw_Agent_Registry — persistent registry of dynamically-created agents.
//
// The Openclaw_Spawner creates a fresh isolated agent for every Trigger_Mention
// (`openclaw agents add rockhub-<timestamp>-<identity>`). Without active
// cleanup these agents accumulate across the lifetime of the process and
// across restarts.
//
// This registry persists every agent name + creation timestamp to a JSON
// file (`<logDir>/agents.json`, sibling to the per-invocation log files)
// and provides a `cleanup()` operation that deletes agents older than a
// configurable TTL (default 2 days). Cleanup runs on startup and on a
// configurable interval (default every hour).
//
// The registry survives restarts: stale entries from previous Rockhub
// processes are pruned on the next startup.

import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type pino from 'pino'

// ── Public Interfaces ──────────────────────────────────────────────

export interface OpenclawAgentRegistryConfig {
  /** Directory to store the registry JSON. Same directory as openclaw logs. */
  logDir: string
  /** Path to the openclaw CLI. Used to invoke `openclaw agents delete`. */
  cliPath: string
  /** Maximum age of an agent before it is eligible for cleanup (ms). */
  maxAgeMs?: number
  /** Cleanup interval (ms). Cleanup also runs on startup. */
  cleanupIntervalMs?: number
}

export interface OpenclawAgentRegistryDeps {
  logger: pino.Logger
}

export interface RegisteredAgent {
  name: string
  createdAt: string
  mentionIdentity: string
  /** Absolute path to the agent's workspace directory. Removed on cleanup. */
  workspaceDir?: string
}

export interface OpenclawAgentRegistryInstance {
  /**
   * Records a newly-created agent in the persistent registry.
   * Synchronous — writes the JSON file before returning.
   */
  register: (agent: { name: string; mentionIdentity: string; workspaceDir?: string }) => void

  /**
   * Returns a snapshot of currently-registered agents.
   */
  list: () => RegisteredAgent[]

  /**
   * Deletes agents older than `maxAgeMs` from both the openclaw runtime
   * (via `openclaw agents delete --force`) and the registry file.
   * Resolves to the count of deleted agents.
   */
  cleanup: () => Promise<{ deleted: number; failed: number }>

  /**
   * Starts the periodic cleanup interval. Idempotent.
   * Also performs an immediate cleanup on first call.
   */
  start: () => Promise<void>

  /**
   * Stops the periodic cleanup interval.
   */
  stop: () => void
}

// ── Defaults ───────────────────────────────────────────────────────

const DEFAULT_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000 // 2 days
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000 // 1 hour
const REGISTRY_FILENAME = 'agents.json'

// ── Factory ────────────────────────────────────────────────────────

export const createOpenclawAgentRegistry = (
  config: OpenclawAgentRegistryConfig,
  deps: OpenclawAgentRegistryDeps,
): OpenclawAgentRegistryInstance => {
  const log = deps.logger.child({ component: 'openclaw-agent-registry' })
  const maxAgeMs = config.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  const cleanupIntervalMs = config.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS
  const registryPath = path.join(config.logDir, REGISTRY_FILENAME)

  let interval: NodeJS.Timeout | null = null

  const register = (agent: {
    name: string
    mentionIdentity: string
    workspaceDir?: string
  }): void => {
    const entries = readRegistry(registryPath, log)
    const newEntry: RegisteredAgent = {
      name: agent.name,
      mentionIdentity: agent.mentionIdentity,
      createdAt: new Date().toISOString(),
      workspaceDir: agent.workspaceDir,
    }
    // Replace any existing entry with the same name (idempotent).
    const filtered = entries.filter((e) => e.name !== agent.name)
    filtered.push(newEntry)
    writeRegistry(registryPath, filtered, log)
    log.debug({ agentName: agent.name, registryPath }, 'Registered openclaw agent')
  }

  const list = (): RegisteredAgent[] => readRegistry(registryPath, log)

  const cleanup = async (): Promise<{ deleted: number; failed: number }> => {
    const entries = readRegistry(registryPath, log)
    const now = Date.now()
    const stale: RegisteredAgent[] = []
    const fresh: RegisteredAgent[] = []

    for (const entry of entries) {
      const age = now - new Date(entry.createdAt).getTime()
      if (Number.isFinite(age) && age >= maxAgeMs) {
        stale.push(entry)
      } else {
        fresh.push(entry)
      }
    }

    if (stale.length === 0) {
      log.debug({ totalAgents: entries.length }, 'Openclaw agent cleanup — no stale agents')
      return { deleted: 0, failed: 0 }
    }

    log.info(
      { stale: stale.length, retained: fresh.length, maxAgeMs },
      'Openclaw agent cleanup — deleting stale agents',
    )

    let deleted = 0
    let failed = 0
    const successfullyDeleted: Set<string> = new Set()

    for (const entry of stale) {
      const ok = await deleteAgent(config.cliPath, entry.name, log)
      if (ok) {
        deleted += 1
        successfullyDeleted.add(entry.name)
        // Remove the workspace directory now that the agent is gone.
        if (entry.workspaceDir) {
          removeWorkspaceDir(entry.workspaceDir, log)
        }
      } else {
        failed += 1
      }
    }

    // Update the registry: keep fresh entries + any stale entries that
    // failed to delete (so we retry on the next cleanup tick).
    const remaining = [...fresh, ...stale.filter((e) => !successfullyDeleted.has(e.name))]
    writeRegistry(registryPath, remaining, log)

    log.info({ deleted, failed, retained: fresh.length }, 'Openclaw agent cleanup complete')
    return { deleted, failed }
  }

  const start = async (): Promise<void> => {
    if (interval !== null) return
    // Run an immediate cleanup on startup.
    try {
      await cleanup()
    } catch (err: unknown) {
      log.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'Initial openclaw agent cleanup failed (continuing)',
      )
    }
    interval = setInterval(() => {
      cleanup().catch((err: unknown) => {
        log.warn(
          { error: err instanceof Error ? err.message : String(err) },
          'Periodic openclaw agent cleanup failed (continuing)',
        )
      })
    }, cleanupIntervalMs)
    // Don't keep the event loop alive solely for the cleanup timer.
    interval.unref()
    log.info({ cleanupIntervalMs, maxAgeMs, registryPath }, 'Openclaw agent registry started')
  }

  const stop = (): void => {
    if (interval !== null) {
      clearInterval(interval)
      interval = null
      log.info('Openclaw agent registry stopped')
    }
  }

  return { register, list, cleanup, start, stop }
}

// ── Internal Helpers ───────────────────────────────────────────────

const readRegistry = (registryPath: string, log: pino.Logger): RegisteredAgent[] => {
  if (!fs.existsSync(registryPath)) return []
  try {
    const raw = fs.readFileSync(registryPath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      log.warn({ registryPath }, 'Registry file is not an array; resetting')
      return []
    }
    return parsed.filter(isRegisteredAgent)
  } catch (err: unknown) {
    log.warn(
      { registryPath, error: err instanceof Error ? err.message : String(err) },
      'Failed to read openclaw agent registry; treating as empty',
    )
    return []
  }
}

const writeRegistry = (
  registryPath: string,
  entries: RegisteredAgent[],
  log: pino.Logger,
): void => {
  try {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true })
    // Atomic write: write to temp then rename.
    const tmpPath = `${registryPath}.tmp`
    fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2), 'utf-8')
    fs.renameSync(tmpPath, registryPath)
  } catch (err: unknown) {
    log.error(
      { registryPath, error: err instanceof Error ? err.message : String(err) },
      'Failed to write openclaw agent registry',
    )
  }
}

const isRegisteredAgent = (value: unknown): value is RegisteredAgent => {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.name === 'string' &&
    typeof v.createdAt === 'string' &&
    typeof v.mentionIdentity === 'string' &&
    (v.workspaceDir === undefined || typeof v.workspaceDir === 'string')
  )
}

const removeWorkspaceDir = (workspaceDir: string, log: pino.Logger): void => {
  try {
    if (fs.existsSync(workspaceDir)) {
      fs.rmSync(workspaceDir, { recursive: true, force: true })
      log.debug({ workspaceDir }, 'Removed openclaw agent workspace directory')
    }
  } catch (err: unknown) {
    log.warn(
      { workspaceDir, error: err instanceof Error ? err.message : String(err) },
      'Failed to remove openclaw agent workspace directory (continuing)',
    )
  }
}

const deleteAgent = async (
  cliPath: string,
  agentName: string,
  log: pino.Logger,
): Promise<boolean> =>
  new Promise((resolve) => {
    const child = childProcess.spawn(
      cliPath,
      ['agents', 'delete', agentName, '--force', '--json'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )

    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
    })

    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      log.warn({ agentName }, 'Openclaw agent delete timed out')
      resolve(false)
    }, 60_000)

    child.on('error', (err) => {
      clearTimeout(timeout)
      log.warn({ agentName, error: err.message }, 'Openclaw agent delete failed (spawn error)')
      resolve(false)
    })

    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code === 0) {
        log.debug({ agentName }, 'Deleted stale openclaw agent')
        resolve(true)
      } else {
        log.warn(
          { agentName, exitCode: code, stderr: stderr.slice(0, 500) },
          'Openclaw agent delete returned non-zero',
        )
        resolve(false)
      }
    })
  })
