// Openclaw_Spawner — fire-and-forget child-process spawner.
//
// For each Trigger_Mention, creates a NEW isolated openclaw agent
// (via `openclaw agents add`) and then invokes `openclaw agent --agent <id>`
// in detached mode with `unref()`. This ensures each task runs in a fully
// independent agent with its own workspace and state — enabling true
// parallelism across multiple mentions.
//
// The spawner is synchronous: it returns immediately after spawn+unref
// with either `{ status: 'spawned', pid, logFile }` or
// `{ status: 'failed', reason }` on synchronous spawn rejection.

import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type pino from 'pino'

import { sanitizeForFilename } from '../lib'
import type { OpenclawInvocation, SynthesizedPayload } from '../lib'

import type { QueuedMention } from './mention-queue'
import type { OpenclawAgentRegistryInstance } from './openclaw-agent-registry'

// ── Public Interfaces ──────────────────────────────────────────────

export interface OpenclawSpawnerConfig {
  cliPath: string
  skillFlag: string
  payloadTransport: 'stdin' | 'argv' | 'env' | 'file'
  logDir: string
}

export interface OpenclawSpawnerDeps {
  logger: pino.Logger
  /**
   * Optional registry of dynamically-created agents. When provided,
   * each spawned agent is recorded so cleanup can prune stale entries.
   */
  agentRegistry?: OpenclawAgentRegistryInstance
}

export interface OpenclawSpawnerInstance {
  spawn: (item: QueuedMention) => OpenclawSpawnOutcome
}

export type OpenclawSpawnOutcome =
  | { status: 'spawned'; pid: number; logFile: string }
  | { status: 'failed'; reason: string }

// ── Factory ────────────────────────────────────────────────────────

export const createOpenclawSpawner = (
  config: OpenclawSpawnerConfig,
  deps: OpenclawSpawnerDeps,
): OpenclawSpawnerInstance => {
  const log = deps.logger.child({ component: 'openclaw-spawner' })

  return { spawn: (item) => spawnChild(config, log, item, deps.agentRegistry) }
}

// ── Internal Implementation ────────────────────────────────────────

const spawnChild = (
  config: OpenclawSpawnerConfig,
  log: pino.Logger,
  item: QueuedMention,
  agentRegistry: OpenclawAgentRegistryInstance | undefined,
): OpenclawSpawnOutcome => {
  const { mention, payload, eventName, deliveryId } = item
  const { identity: mentionIdentity, repoFullName, sourceType } = mention

  // Build the OpenclawInvocation envelope.
  const origin: 'webhook' | 'startup-scan' = isStartupScanPayload(payload)
    ? 'startup-scan'
    : 'webhook'

  const envelope: OpenclawInvocation = {
    skill: 'rockhub',
    mentionIdentity,
    eventName,
    deliveryId,
    origin,
    payload,
  }

  // Construct per-invocation log filename.
  const timestamp = formatTimestamp(new Date())
  const sanitizedIdentity = sanitizeForFilename(mentionIdentity)
  const logFilename = `${timestamp}_${sanitizedIdentity}.log`
  const logFilePath = path.join(config.logDir, logFilename)

  // Ensure log directory exists.
  fs.mkdirSync(config.logDir, { recursive: true })

  // Open log file FDs for stdout and stderr.
  const outFd = fs.openSync(logFilePath, 'a')
  const errFd = fs.openSync(logFilePath, 'a')

  // Create a unique agent name for this invocation so it runs in full isolation.
  const agentName = `rockhub-${timestamp}-${sanitizedIdentity}`.slice(0, 80)

  // Per-agent workspace directory (required by `openclaw agents add --non-interactive`).
  // Located under the log dir so cleanup is co-located with logs and the registry.
  const agentWorkspaceDir = path.join(config.logDir, 'workspaces', agentName)
  fs.mkdirSync(agentWorkspaceDir, { recursive: true })

  // Write the payload file (all transports use file-based delivery now).
  const payloadFilePath = writePayloadFile(envelope)

  // Create the isolated agent synchronously before spawning.
  // This gives the agent its own workspace and state directory.
  try {
    const addResult = childProcess.execFileSync(
      config.cliPath,
      ['agents', 'add', agentName, '--non-interactive', '--workspace', agentWorkspaceDir, '--json'],
      {
        timeout: 60_000,
        encoding: 'utf-8',
        env: { ...process.env },
      },
    )
    log.debug(
      { agentName, workspace: agentWorkspaceDir, result: addResult.trim() },
      'Created isolated openclaw agent',
    )

    // Register the agent in the persistent registry so it can be cleaned up
    // later if it lingers past the configured TTL.
    if (agentRegistry) {
      agentRegistry.register({ name: agentName, mentionIdentity, workspaceDir: agentWorkspaceDir })
    }
  } catch (err: unknown) {
    closeFds(outFd, errFd)
    const reason = err instanceof Error ? err.message : String(err)
    log.error(
      {
        mentionIdentity,
        agentName,
        cliPath: config.cliPath,
        repo: repoFullName,
        sourceType,
        error: reason,
      },
      'Failed to create isolated openclaw agent',
    )
    return { status: 'failed', reason: `agent creation failed: ${reason}` }
  }

  // Build argv: openclaw agent --agent <name> --local --message "/rockhub <payload-path>"
  const args = buildArgs(config, agentName, payloadFilePath, envelope)

  // Determine stdio configuration based on transport.
  const stdinMode = config.payloadTransport === 'stdin' ? 'pipe' : 'ignore'
  const stdio: childProcess.StdioOptions = [stdinMode, outFd, errFd]

  // Build env for the child (inherit parent env, add payload env if applicable).
  const childEnv = buildEnv(config, envelope)

  try {
    const child = childProcess.spawn(config.cliPath, args, {
      detached: true,
      stdio,
      env: childEnv,
    })

    // One-shot 'error' listener for synchronous spawn rejection (ENOENT, EACCES).
    const errorListener = (err: Error): void => {
      log.error(
        {
          mentionIdentity,
          cliPath: config.cliPath,
          repo: repoFullName,
          sourceType,
          error: err.message,
        },
        'Openclaw child process error after spawn',
      )
    }
    child.on('error', errorListener)

    // For stdin transport: write the envelope and close stdin.
    if (config.payloadTransport === 'stdin' && child.stdin) {
      child.stdin.write(JSON.stringify(envelope))
      child.stdin.end()
    }

    // Remove the one-shot error listener before unref.
    child.removeListener('error', errorListener)

    // Fire-and-forget: unref immediately.
    child.unref()

    // Close the FDs in the parent process — the child owns them now.
    closeFds(outFd, errFd)

    // If spawn failed to produce a pid, treat as failure.
    if (child.pid == null) {
      const reason = 'spawn did not produce a child pid'
      log.error(
        { mentionIdentity, cliPath: config.cliPath, repo: repoFullName, sourceType },
        reason,
      )
      return { status: 'failed', reason }
    }

    log.info(
      {
        mentionIdentity,
        pid: child.pid,
        logFile: logFilePath,
        agentName,
        repo: repoFullName,
        sourceType,
      },
      'Openclaw subagent spawned (dedicated agent)',
    )

    log.debug(
      {
        cmd: config.cliPath,
        args,
        transport: config.payloadTransport,
        logFile: logFilePath,
        agentName,
      },
      `Openclaw exec: ${config.cliPath} ${args.join(' ')}`,
    )

    return { status: 'spawned', pid: child.pid, logFile: logFilePath }
  } catch (err: unknown) {
    // Synchronous spawn failure (e.g., ENOENT when binary not found).
    closeFds(outFd, errFd)
    const reason = err instanceof Error ? err.message : String(err)
    log.error(
      { mentionIdentity, cliPath: config.cliPath, repo: repoFullName, sourceType, error: reason },
      'Openclaw spawn failed synchronously',
    )
    return { status: 'failed', reason }
  }
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Formats a Date as `YYYYMMDD-HHmmss-SSS` for the log filename.
 */
const formatTimestamp = (date: Date): string => {
  const y = date.getFullYear()
  const mo = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const h = String(date.getHours()).padStart(2, '0')
  const mi = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  const ms = String(date.getMilliseconds()).padStart(3, '0')
  return `${String(y)}${mo}${d}-${h}${mi}${s}-${ms}`
}

/**
 * Builds the argv array for the child process.
 *
 * Each invocation targets a dedicated isolated agent:
 *   openclaw agent --agent <agentName> --local --message "/rockhub <payload-file-path>"
 *
 * The `skillFlag` config is parsed for any additional flags (e.g. "--local --message")
 * which get split on whitespace into separate argv entries.
 */
const buildArgs = (
  config: OpenclawSpawnerConfig,
  agentName: string,
  payloadFilePath: string,
  envelope: OpenclawInvocation,
): string[] => {
  // Split subcommand string into argv parts (e.g. "agent --local --message" → ["agent", "--local", "--message"])
  const subcommandParts = config.skillFlag.split(/\s+/).filter(Boolean)

  // Insert --agent <name> after the first subcommand word (e.g. after "agent")
  // This targets the dedicated isolated agent we just created.
  const partsWithAgent =
    subcommandParts.length > 0
      ? [subcommandParts[0], '--agent', agentName, ...subcommandParts.slice(1)]
      : ['agent', '--agent', agentName, '--local', '--message']

  switch (config.payloadTransport) {
    case 'argv':
      // Inline JSON in the message (legacy behavior)
      return [...partsWithAgent, `/rockhub ${JSON.stringify(envelope)}`]
    case 'file':
    case 'stdin':
    case 'env':
    default:
      // Pass the payload file path so the skill can locate the event data
      return [...partsWithAgent, `/rockhub ${payloadFilePath}`]
  }
}

/**
 * Writes the OpenclawInvocation envelope to a JSON file in the system
 * temp directory and returns the absolute path.
 */
const writePayloadFile = (envelope: OpenclawInvocation): string => {
  const payloadsDir = path.join(os.tmpdir(), 'rockhub-payloads')
  fs.mkdirSync(payloadsDir, { recursive: true })
  const filename = `${formatTimestamp(new Date())}_${sanitizeForFilename(envelope.mentionIdentity)}.json`
  const filePath = path.join(payloadsDir, filename)
  fs.writeFileSync(filePath, JSON.stringify(envelope), 'utf-8')
  return filePath
}

/**
 * Builds the environment for the child process. For 'env' transport,
 * sets `ROCKHUB_PAYLOAD_JSON`. Otherwise inherits parent env.
 */
const buildEnv = (
  config: OpenclawSpawnerConfig,
  envelope: OpenclawInvocation,
): NodeJS.ProcessEnv => {
  if (config.payloadTransport === 'env') {
    return { ...process.env, ROCKHUB_PAYLOAD_JSON: JSON.stringify(envelope) }
  }
  return { ...process.env }
}

/**
 * Determines if a payload is a startup-scan synthesized payload.
 */
const isStartupScanPayload = (payload: QueuedMention['payload']): payload is SynthesizedPayload =>
  'rockhub_origin' in payload

/**
 * Safely closes file descriptors, ignoring errors if already closed.
 */
const closeFds = (...fds: number[]): void => {
  for (const fd of fds) {
    try {
      fs.closeSync(fd)
    } catch {
      // Already closed or invalid — ignore.
    }
  }
}
