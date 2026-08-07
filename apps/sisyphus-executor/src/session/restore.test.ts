import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import { sessionLogDirectory } from './conversation-log'
import {
  restoreSession,
  SnapshotIncompleteError,
  SnapshotUnavailableError,
  verifyRestoredWorkspace,
} from './restore'
import { createSnapshotWriter } from './snapshot'
import type { FakeSnapshotStore } from './snapshot-store'
import { createFakeSnapshotStore } from './snapshot-store'

/**
 * T098, and the half of spike S2 that is now production code.
 *
 * Every case here destroys the pinned root between capture and restore, exactly as the spike did.
 * Two side-by-side directories with different absolute paths would quietly test something easier:
 * the claim is that a restore works **because** the root is a fixed absolute path, so the root has
 * to genuinely go away and genuinely come back to the same place.
 *
 * What this still does not prove is what SPIKE-FINDINGS.md says it does not: instance identity is a
 * directory, not a machine. No instance metadata, no reclamation notice, no S3, and no real
 * `--resume` — the session is findable and the log parses, which is a claim about files rather than
 * about the agent.
 */

const run = promisify(execFile)

const PREDECESSOR_SESSION = '0199a1f4-0000-7000-8000-0000000000a1'
const SUCCESSOR_SESSION = '0199a1f4-0000-7000-8000-0000000000b2'

const gitEnv = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'restore-test',
  GIT_AUTHOR_EMAIL: 'restore@example.invalid',
  GIT_COMMITTER_NAME: 'restore-test',
  GIT_COMMITTER_EMAIL: 'restore@example.invalid',
}

const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await run('git', [...args], { cwd, env: { ...process.env, ...gitEnv } })

  return stdout
}

interface Instance {
  readonly scratch: string
  readonly workspaceRoot: string
  readonly store: FakeSnapshotStore
  readonly s3Key: string
}

const scratches: string[] = []

/**
 * Build a workspace, snapshot it, then destroy the root — an instance that has gone away.
 *
 * @param options.withRepository - When false, the tree has conversation state and no working tree,
 *   which is the case restore must refuse rather than report ready.
 * @param options.truncateLog - Cut the final line mid-token, as a crash mid-append leaves it.
 */
const captureAndDestroy = async (options: {
  readonly withRepository: boolean
  readonly truncateLog: boolean
}): Promise<Instance> => {
  const scratch = await mkdtemp(join(tmpdir(), 'sisyphus-restore-test-'))

  scratches.push(scratch)

  const workspaceRoot = join(scratch, 'workspace')
  const configDir = join(workspaceRoot, '.agent-config')

  await mkdir(workspaceRoot, { recursive: true })

  if (options.withRepository) {
    const repository = join(workspaceRoot, 'primary')

    await mkdir(repository, { recursive: true })
    await git(repository, ['init', '--initial-branch=main'])
    await writeFile(join(repository, 'tracked.txt'), 'original\n')
    await git(repository, ['add', '.'])
    await git(repository, ['commit', '-m', 'baseline'])
    await writeFile(join(repository, 'tracked.txt'), 'edited by the agent, never committed\n')
    await writeFile(join(repository, 'scratch-notes.md'), 'untracked working notes\n')
  }

  const logDirectory = sessionLogDirectory(configDir, workspaceRoot)

  await mkdir(logDirectory, { recursive: true })

  const intact = [0, 1, 2, 3].map((sequence) =>
    JSON.stringify({ type: 'user', sessionId: PREDECESSOR_SESSION, sequence }),
  )
  const tail = options.truncateLog
    ? `{"type":"assistant","sessionId":"${PREDECESSOR_SESSION}","content":[{"ty`
    : JSON.stringify({ type: 'assistant', sessionId: PREDECESSOR_SESSION, sequence: 4 })

  await writeFile(
    join(logDirectory, `${PREDECESSOR_SESSION}.jsonl`),
    `${intact.join('\n')}\n${tail}`,
  )

  await mkdir(join(configDir, 'credentials'), { recursive: true })
  await writeFile(join(configDir, 'credentials', 'token'), 'a-client-credential\n')

  const store = createFakeSnapshotStore()
  const captured = await createSnapshotWriter({
    store,
    bucket: 'snapshots.test',
    workflowId: 'wf-predecessor',
  }).capture({
    boundary: 'interruption',
    sessionId: PREDECESSOR_SESSION,
    workspaceRoot,
  })

  // The instance is destroyed. Nothing below can be reading leftovers.
  await rm(workspaceRoot, { recursive: true, force: true })
  expect(existsSync(workspaceRoot)).toBe(false)

  return { scratch, workspaceRoot, store, s3Key: captured.s3Key }
}

afterEach(async () => {
  await Promise.all(scratches.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('verifyRestoredWorkspace', () => {
  it('reports no worktree for a root that is not there at all', async () => {
    await expect(verifyRestoredWorkspace('/nowhere/at/all/workspace')).resolves.toStrictEqual({
      entryPaths: [],
      hasWorktreeState: false,
    })
  })

  it('counts an entry only when it holds a .git — a bag of files is not a working tree', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'sisyphus-verify-'))

    scratches.push(scratch)

    await mkdir(join(scratch, 'looks-like-code'), { recursive: true })
    await writeFile(join(scratch, 'looks-like-code', 'main.ts'), 'export {}\n')

    await expect(verifyRestoredWorkspace(scratch)).resolves.toStrictEqual({
      entryPaths: [],
      hasWorktreeState: false,
    })
  })
})

describe('restoreSession', () => {
  it('restores the tree onto the identical absolute path, uncommitted work intact', async () => {
    const instance = await captureAndDestroy({ withRepository: true, truncateLog: true })

    const restored = await restoreSession({
      store: instance.store,
      bucket: 'snapshots.test',
      snapshot: {
        s3Key: instance.s3Key,
        sessionId: PREDECESSOR_SESSION,
        boundary: 'interruption',
      },
      workspaceRoot: instance.workspaceRoot,
    })

    expect(restored.workspaceRoot).toBe(instance.workspaceRoot)
    expect(restored.entryPaths).toStrictEqual([join(instance.workspaceRoot, 'primary')])

    const repository = join(instance.workspaceRoot, 'primary')

    await expect(readFile(join(repository, 'tracked.txt'), 'utf8')).resolves.toBe(
      'edited by the agent, never committed\n',
    )
    expect(existsSync(join(repository, 'scratch-notes.md'))).toBe(true)

    // `.git` came across intact, so the tree still knows it has been modified.
    const status = await git(repository, ['status', '--porcelain'])

    expect(status).toContain('tracked.txt')
    expect(status).toContain('scratch-notes.md')
  }, 60_000)

  it('treats a truncated trailing line as a normal path (FR-053)', async () => {
    const instance = await captureAndDestroy({ withRepository: true, truncateLog: true })

    const restored = await restoreSession({
      store: instance.store,
      bucket: 'snapshots.test',
      snapshot: {
        s3Key: instance.s3Key,
        sessionId: PREDECESSOR_SESSION,
        boundary: 'interruption',
      },
      workspaceRoot: instance.workspaceRoot,
    })

    expect(restored.truncationRepaired).toBe(true)
    // Five lines went in; the four complete ones come out and the partial one is dropped.
    expect(restored.conversationEntries).toBe(4)
  }, 60_000)

  it('reports no repair when the log was written completely', async () => {
    const instance = await captureAndDestroy({ withRepository: true, truncateLog: false })

    const restored = await restoreSession({
      store: instance.store,
      bucket: 'snapshots.test',
      snapshot: {
        s3Key: instance.s3Key,
        sessionId: PREDECESSOR_SESSION,
        boundary: 'interruption',
      },
      workspaceRoot: instance.workspaceRoot,
    })

    expect(restored.truncationRepaired).toBe(false)
    expect(restored.conversationEntries).toBe(5)
  }, 60_000)

  it('never carries the credential across the restore (FR-072)', async () => {
    const instance = await captureAndDestroy({ withRepository: true, truncateLog: false })

    await restoreSession({
      store: instance.store,
      bucket: 'snapshots.test',
      snapshot: {
        s3Key: instance.s3Key,
        sessionId: PREDECESSOR_SESSION,
        boundary: 'interruption',
      },
      workspaceRoot: instance.workspaceRoot,
    })

    expect(existsSync(join(instance.workspaceRoot, '.agent-config', 'credentials', 'token'))).toBe(
      false,
    )
    // …and the conversation state, its sibling, is right there.
    expect(
      existsSync(
        join(
          sessionLogDirectory(
            join(instance.workspaceRoot, '.agent-config'),
            instance.workspaceRoot,
          ),
          `${PREDECESSOR_SESSION}.jsonl`,
        ),
      ),
    ).toBe(true)
  }, 60_000)

  it('refuses to report ready when the working tree is absent (FR-050)', async () => {
    const instance = await captureAndDestroy({ withRepository: false, truncateLog: false })

    const failure = await restoreSession({
      store: instance.store,
      bucket: 'snapshots.test',
      snapshot: {
        s3Key: instance.s3Key,
        sessionId: PREDECESSOR_SESSION,
        boundary: 'interruption',
      },
      workspaceRoot: instance.workspaceRoot,
    }).catch((caught: unknown) => caught)

    expect(failure).toBeInstanceOf(SnapshotIncompleteError)
    expect((failure as SnapshotIncompleteError).missing).toStrictEqual(['worktree'])
    expect((failure as Error).message).toContain('must not be started')
  }, 60_000)

  it('names the conversation half when the log for that session is not in the archive', async () => {
    const instance = await captureAndDestroy({ withRepository: true, truncateLog: false })

    const failure = await restoreSession({
      store: instance.store,
      bucket: 'snapshots.test',
      // A session id the snapshot knows nothing about — the successor-confusion failure, forced.
      snapshot: { s3Key: instance.s3Key, sessionId: SUCCESSOR_SESSION, boundary: 'interruption' },
      workspaceRoot: instance.workspaceRoot,
    }).catch((caught: unknown) => caught)

    expect(failure).toBeInstanceOf(SnapshotIncompleteError)
    expect((failure as SnapshotIncompleteError).missing).toStrictEqual(['conversation'])
  }, 60_000)

  it('resumes a successor under the predecessor’s recorded id, keeping its own (FR-150)', async () => {
    const instance = await captureAndDestroy({ withRepository: true, truncateLog: false })

    const restored = await restoreSession({
      store: instance.store,
      bucket: 'snapshots.test',
      snapshot: {
        s3Key: instance.s3Key,
        sessionId: PREDECESSOR_SESSION,
        boundary: 'interruption',
      },
      workspaceRoot: instance.workspaceRoot,
      workflowSessionId: SUCCESSOR_SESSION,
    })

    expect(restored.resumeSessionId).toBe(PREDECESSOR_SESSION)
    expect(restored.workflowSessionId).toBe(SUCCESSOR_SESSION)
    expect(restored.resumesPredecessorSession).toBe(true)
  }, 60_000)

  it('reports the two ids as equal when a run resumes itself', async () => {
    const instance = await captureAndDestroy({ withRepository: true, truncateLog: false })

    const restored = await restoreSession({
      store: instance.store,
      bucket: 'snapshots.test',
      snapshot: {
        s3Key: instance.s3Key,
        sessionId: PREDECESSOR_SESSION,
        boundary: 'pause',
      },
      workspaceRoot: instance.workspaceRoot,
    })

    expect(restored.resumeSessionId).toBe(PREDECESSOR_SESSION)
    expect(restored.workflowSessionId).toBe(PREDECESSOR_SESSION)
    expect(restored.resumesPredecessorSession).toBe(false)
  }, 60_000)

  it('parks and retries an unreachable store rather than failing the restore (FR-082)', async () => {
    const instance = await captureAndDestroy({ withRepository: true, truncateLog: false })
    const reports: number[] = []

    instance.store.failNext(2)

    const restored = await restoreSession({
      store: instance.store,
      bucket: 'snapshots.test',
      snapshot: { s3Key: instance.s3Key, sessionId: PREDECESSOR_SESSION, boundary: 'stop' },
      workspaceRoot: instance.workspaceRoot,
      sleep: () => Promise.resolve(),
      onParked: (report) => reports.push(report.attempt),
    })

    expect(reports).toStrictEqual([1, 2])
    expect(restored.parkedAttempts).toBe(2)
    expect(restored.entryPaths).toHaveLength(1)
  }, 60_000)

  it('names the key it could not fetch once the budget is exhausted', async () => {
    const instance = await captureAndDestroy({ withRepository: true, truncateLog: false })

    instance.store.failNext(10)

    const failure = await restoreSession({
      store: instance.store,
      bucket: 'snapshots.test',
      snapshot: { s3Key: instance.s3Key, sessionId: PREDECESSOR_SESSION, boundary: 'stop' },
      workspaceRoot: instance.workspaceRoot,
      parkBudget: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 2, factor: 2 },
      sleep: () => Promise.resolve(),
    }).catch((caught: unknown) => caught)

    expect(failure).toBeInstanceOf(SnapshotUnavailableError)
    expect((failure as SnapshotUnavailableError).s3Key).toBe(instance.s3Key)
    expect((failure as SnapshotUnavailableError).attempts).toBe(3)
    expect(existsSync(instance.workspaceRoot)).toBe(false)
  }, 60_000)
})
