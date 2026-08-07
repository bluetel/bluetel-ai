/**
 * **Restore (T098, FR-050, FR-051, FR-053, FR-082, R2).**
 *
 * Download the snapshot, unpack it onto the pinned root — the **same absolute path** it was taken
 * from — read the conversation log, and only then say the instance is ready.
 *
 * ## Two things this module treats as ordinary that look like errors
 *
 * **A truncated trailing line in the conversation log is a normal path.** The log is append-only
 * and is not written atomically, so an instance that died mid-append leaves a partial final line;
 * treating that as corruption would make every hard interruption unrecoverable, which is the exact
 * scenario the snapshot exists for. `parseConversationLog` discards it and records
 * `truncationRepaired` (FR-053). A line that fails to parse anywhere **other** than at the end is
 * a different thing and still throws, because that is corruption and the two must not be conflated.
 *
 * **A store that is briefly unreachable is not a failed restore.** The download goes through
 * `parkAndRetry` — the same budget and the same reporting `suspend()` uses at a snapshot boundary
 * (FR-082) — rather than a second retry loop with its own opinion of how long is too long. What
 * this module adds is the wording: park's error is about a boundary that could not be *persisted*,
 * and here nothing is being persisted, so it is caught and re-raised as
 * {@link SnapshotUnavailableError}, naming the key that could not be fetched.
 *
 * ## The check before "ready", and why it is not optional
 *
 * Conversation state without worktree state desynchronises the model's beliefs about the filesystem
 * from reality. The agent resumes convinced it has already edited files that are not there, and
 * then edits them again — or, worse, reads them, finds its own change missing, and reasons from
 * that. There is no signal that any of this has happened: the run looks healthy and produces
 * nonsense. So {@link verifyRestoredWorkspace} runs **before** anything reports ready, and a
 * missing working tree raises {@link SnapshotIncompleteError} rather than returning a result with
 * a flag on it that a caller could forget to read.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { agentConfigDir, AGENT_CONFIG_DIR_NAME } from '../bootstrap'

import { parseConversationLog, sessionLogDirectory } from './conversation-log'
import type { ParkBudget, ParkReport, SnapshotBoundary } from './park'
import { parkAndRetry, SnapshotBoundaryUnpersistedError } from './park'
import { unpackWorkspaceArchive } from './snapshot-archive'
import type { SnapshotObjectStore } from './snapshot-store'

/** The stored snapshot a restore is pointed at. */
export interface SnapshotReference {
  readonly s3Key: string
  /**
   * The session id recorded **on the snapshot** — the id `--resume` must name.
   *
   * For a successor workflow (FR-150) this is the **predecessor's** id, not the successor's own.
   * See {@link RestoreOptions.workflowSessionId}.
   */
  readonly sessionId: string
  /** Why the snapshot was taken. Carried so a park failure can say which one it could not fetch. */
  readonly boundary: SnapshotBoundary
}

export interface RestoreOptions {
  readonly store: SnapshotObjectStore
  readonly bucket: string
  readonly snapshot: SnapshotReference
  /** The pinned root (FR-051). The archive is unpacked back onto exactly this path. */
  readonly workspaceRoot: string
  /** Defaults to `<root>/.agent-config`, where bootstrap relocated it (R2). */
  readonly configDir?: string
  /**
   * The **run's own** platform-assigned session id (FR-052).
   *
   * Equal to `snapshot.sessionId` when a workflow resumes itself. Different for a successor, which
   * inherits the predecessor's snapshot and keeps its own id — and which must still resume under
   * the predecessor's, because that is the id the conversation log on disk is filed under.
   * Conflating them makes `--resume` fail by finding nothing rather than by erroring.
   */
  readonly workflowSessionId?: string
  readonly parkBudget?: ParkBudget
  readonly onParked?: (report: ParkReport) => void
  readonly sleep?: (milliseconds: number) => Promise<void>
  readonly scratchDir?: string
  readonly signal?: AbortSignal
}

/** The snapshot could not be fetched, after the whole park budget (FR-082). */
export class SnapshotUnavailableError extends Error {
  readonly s3Key: string
  readonly attempts: number

  constructor(options: {
    readonly s3Key: string
    readonly attempts: number
    readonly cause?: unknown
  }) {
    super(
      `the session snapshot at ${options.s3Key} could not be fetched after ` +
        `${String(options.attempts)} attempts, so this instance has nothing to resume from`,
      { cause: options.cause },
    )
    this.name = 'SnapshotUnavailableError'
    this.s3Key = options.s3Key
    this.attempts = options.attempts
  }
}

/**
 * The restored tree is missing one of the two halves FR-050 requires.
 *
 * Raised **instead of** reporting ready. Naming which half is missing is the whole value of the
 * error: "no working tree" and "no conversation log" are recovered from differently, and an
 * operator reading "restore failed" learns neither.
 */
export class SnapshotIncompleteError extends Error {
  readonly missing: readonly ('conversation' | 'worktree')[]

  constructor(missing: readonly ('conversation' | 'worktree')[]) {
    super(
      `the restored workspace is missing its ${missing.join(' and ')} state, so the agent must ` +
        'not be started against it — resuming a conversation onto a tree that does not match it ' +
        'leaves the model editing files it believes it has already changed',
    )
    this.name = 'SnapshotIncompleteError'
    this.missing = missing
  }
}

/** What the restored tree looks like on disk. */
export interface RestoredWorkspace {
  /** Absolute paths of the checked-out entries — a directory beneath the root holding a `.git`. */
  readonly entryPaths: readonly string[]
  readonly hasWorktreeState: boolean
}

/**
 * Inspect the restored root for working trees.
 *
 * An entry counts only when it holds a `.git`: a directory of files that has forgotten it is a
 * repository cannot report its own uncommitted work, and uncommitted work is what the snapshot was
 * taken to keep. The config tree is skipped rather than special-cased away later, because it is
 * not an entry and never was.
 *
 * @param workspaceRoot - The pinned root, after extraction.
 */
export const verifyRestoredWorkspace = async (
  workspaceRoot: string,
): Promise<RestoredWorkspace> => {
  if (!existsSync(workspaceRoot)) {
    return { entryPaths: [], hasWorktreeState: false }
  }

  const children = await readdir(workspaceRoot, { withFileTypes: true })

  const entryPaths = children
    .filter((child) => child.isDirectory() && child.name !== AGENT_CONFIG_DIR_NAME)
    .map((child) => join(workspaceRoot, child.name))
    .filter((path) => existsSync(join(path, '.git')))
    .sort()

  return { entryPaths, hasWorktreeState: entryPaths.length > 0 }
}

/** A restored, verified session. Holding one of these means the agent may be started. */
export interface RestoredSession {
  /**
   * The id `--resume` must name: the one recorded on the snapshot.
   *
   * For a successor this is the predecessor's id. {@link RestoredSession.workflowSessionId} is the
   * run's own, and they are reported separately rather than reduced to one field.
   */
  readonly resumeSessionId: string
  /** The run's own platform-assigned id (FR-052), or the same value when a run resumes itself. */
  readonly workflowSessionId: string
  /** True when the two differ — a successor restoring its predecessor's conversation (FR-150). */
  readonly resumesPredecessorSession: boolean
  readonly workspaceRoot: string
  readonly entryPaths: readonly string[]
  readonly conversationEntries: number
  /** A partial final line was discarded. A normal outcome, reported so it is not invisible. */
  readonly truncationRepaired: boolean
  /** How many storage attempts failed before the archive arrived (FR-082). */
  readonly parkedAttempts: number
}

const downloadSnapshot = async (options: RestoreOptions, archivePath: string): Promise<number> => {
  let parkedAttempts = 0

  try {
    await parkAndRetry({
      boundary: options.snapshot.boundary,
      ...(options.parkBudget === undefined ? {} : { budget: options.parkBudget }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      onParked: (report) => {
        parkedAttempts = report.attempt
        options.onParked?.(report)
      },
      operation: () =>
        options.store.get({ bucket: options.bucket, key: options.snapshot.s3Key }, archivePath),
    })
  } catch (error) {
    if (error instanceof SnapshotBoundaryUnpersistedError) {
      throw new SnapshotUnavailableError({
        s3Key: options.snapshot.s3Key,
        attempts: error.attempts,
        cause: error,
      })
    }

    throw error
  }

  return parkedAttempts
}

/**
 * Restore a snapshot onto this instance and continue the existing conversation (FR-053).
 *
 * @param options - See {@link RestoreOptions}.
 * @returns The verified session. The agent may be started only against one of these.
 * @throws SnapshotUnavailableError when storage stayed unreachable for the whole park budget.
 * @throws SnapshotIncompleteError when the restored tree is missing conversation or worktree state.
 */
export const restoreSession = async (options: RestoreOptions): Promise<RestoredSession> => {
  const configDir = options.configDir ?? agentConfigDir(options.workspaceRoot)
  const scratch = await mkdtemp(join(options.scratchDir ?? tmpdir(), 'sisyphus-restore-'))

  try {
    const archivePath = join(scratch, 'snapshot.tar.zst')
    const parkedAttempts = await downloadSnapshot(options, archivePath)

    await unpackWorkspaceArchive({
      archivePath,
      tarPath: join(scratch, 'snapshot.tar'),
      workspaceRoot: options.workspaceRoot,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })

    // Both halves are checked before anything reports ready, and the missing ones are collected
    // rather than short-circuited: an instance told only "no worktree" would restore, fix that,
    // and discover the second problem on the next boot.
    const workspace = await verifyRestoredWorkspace(options.workspaceRoot)
    const logPath = join(
      sessionLogDirectory(configDir, options.workspaceRoot),
      `${options.snapshot.sessionId}.jsonl`,
    )
    const hasConversationState = existsSync(logPath)
    const missing: ('conversation' | 'worktree')[] = []

    if (!hasConversationState) {
      missing.push('conversation')
    }

    if (!workspace.hasWorktreeState) {
      missing.push('worktree')
    }

    if (missing.length > 0) {
      throw new SnapshotIncompleteError(missing)
    }

    const log = parseConversationLog(await readFile(logPath, 'utf8'))
    const workflowSessionId = options.workflowSessionId ?? options.snapshot.sessionId

    return {
      resumeSessionId: options.snapshot.sessionId,
      workflowSessionId,
      resumesPredecessorSession: workflowSessionId !== options.snapshot.sessionId,
      workspaceRoot: options.workspaceRoot,
      entryPaths: workspace.entryPaths,
      conversationEntries: log.entries.length,
      truncationRepaired: log.truncationRepaired,
      parkedAttempts,
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
