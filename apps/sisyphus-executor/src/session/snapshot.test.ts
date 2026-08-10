import { execFile } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { createZstdDecompress } from 'node:zlib'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { agentCredentialPath } from '../bootstrap'
import { gitFixtureEnvironment } from '../git-fixture-environment'

import { sessionLogDirectory } from './conversation-log'
import {
  CONVERSATION_SUBTREE,
  containsCredentialMaterial,
  CREDENTIAL_SUBTREE,
  createSnapshotWriter,
  snapshotExcludePatterns,
  snapshotObjectKey,
  snapshotStateFlags,
} from './snapshot'
import { listArchiveMembers } from './snapshot-archive'
import { createFakeSnapshotStore } from './snapshot-store'

/**
 * T097. The archive is real — real `tar`, real zstd, a real git repository with real uncommitted
 * work — because every claim worth making here is a claim about what ended up inside a file.
 *
 * ## The credential test, and what would break it
 *
 * FR-072 forbids a credential in a snapshot, and the obvious way to satisfy that is an exclusion
 * glob that is slightly too wide. So the fixture plants three decoys, each of which survives only
 * if the glob stays exactly `./<root>/.agent-config/credentials`:
 *
 * - `.agent-config/projects/…/<session>.jsonl` — lost if the glob widened to `.agent-config`,
 *   which would also flip `hasConversationState` to false;
 * - `.agent-config/credentials-notes.md` — lost if the glob widened to a `credentials*` prefix;
 * - `primary/credentials/keep.txt` — a repository directory that happens to be called
 *   `credentials`, lost if the glob stopped being anchored to the archive member name.
 *
 * All three are asserted **present**, and the credential itself absent, against the same listing.
 */

const run = promisify(execFile)

const SESSION_ID = '0199a1f4-0000-7000-8000-00000000c0de'

/**
 * The child's whole environment, composed rather than merged over `process.env` — see
 * `../git-fixture-environment.ts`. An inherited `GIT_DIR`, which is what git exports into a hook
 * process, would have the fixture's `git init` re-initialise the repository the hook is running in
 * and leave this suite asserting against an archive of somebody else's working tree.
 */
const gitEnv = gitFixtureEnvironment()

const git = async (cwd: string, args: readonly string[]): Promise<void> => {
  await run('git', [...args], { cwd, env: gitEnv })
}

describe('snapshotExcludePatterns', () => {
  it('excludes the credential subtree and nothing else (FR-072)', () => {
    expect(snapshotExcludePatterns('/workspace')).toStrictEqual([
      './workspace/.agent-config/credentials',
    ])
  })

  it('is anchored to the archive member name, so it cannot match a repository directory', () => {
    const [pattern] = snapshotExcludePatterns('/workspace')

    expect(pattern.startsWith('./workspace/')).toBe(true)
    expect(pattern).not.toContain('*')
  })

  /**
   * 003/T061, FR-013. The exclusion and the install path have to be the *same* path or the
   * requirement is not met, and "the same path" is easy to lose to a rename at one end. Asserted
   * against `agentCredentialPath` directly rather than against a second copy of the string.
   */
  it('covers exactly where credential_install writes (003/FR-013)', () => {
    const [pattern] = snapshotExcludePatterns('/workspace')

    expect(agentCredentialPath('/workspace').startsWith(pattern.replace('./', '/'))).toBe(true)
  })

  it('never excludes the config tree itself — conversation state must be captured (FR-051)', () => {
    const [pattern] = snapshotExcludePatterns('/workspace')

    expect(pattern).not.toBe('./workspace/.agent-config')
    expect(pattern).toContain(CREDENTIAL_SUBTREE)
    expect(pattern).not.toContain(CONVERSATION_SUBTREE)
  })
})

describe('snapshotStateFlags', () => {
  it('reads both flags out of the archive listing rather than assuming them (FR-050)', () => {
    expect(
      snapshotStateFlags([
        './workspace/.agent-config/projects/-workspace/abc.jsonl',
        './workspace/primary/.git/HEAD',
      ]),
    ).toStrictEqual({ hasConversationState: true, hasWorktreeState: true })
  })

  it('reports a missing worktree rather than a resumable-looking snapshot', () => {
    expect(
      snapshotStateFlags(['./workspace/.agent-config/projects/-workspace/abc.jsonl']),
    ).toStrictEqual({ hasConversationState: true, hasWorktreeState: false })
  })

  it('reports a missing conversation log the same way', () => {
    expect(snapshotStateFlags(['./workspace/primary/.git/HEAD'])).toStrictEqual({
      hasConversationState: false,
      hasWorktreeState: true,
    })
  })
})

describe('snapshotObjectKey', () => {
  it('partitions per workflow and per session, and names the boundary (FR-071)', () => {
    const key = snapshotObjectKey({
      workflowId: 'wf-1',
      sessionId: SESSION_ID,
      boundary: 'interruption',
      at: new Date('2026-08-05T11:22:33.456Z'),
    })

    expect(key).toBe(`snapshots/wf-1/${SESSION_ID}/2026-08-05T11-22-33-456Z-interruption.tar.zst`)
  })
})

describe('createSnapshotWriter', () => {
  let scratch = ''
  let workspaceRoot = ''
  let store = createFakeSnapshotStore()
  let members: readonly string[] = []
  let captured = {
    s3Key: '',
    sizeBytes: 0,
    hasConversationState: false,
    hasWorktreeState: false,
  }

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'sisyphus-snapshot-test-'))
    // Pinned relative to a per-run scratch root, because a test cannot create `/workspace`. The
    // property under test — one absolute path, packed from its parent — is preserved.
    workspaceRoot = join(scratch, 'workspace')

    const repository = join(workspaceRoot, 'primary')
    const configDir = join(workspaceRoot, '.agent-config')

    await mkdir(repository, { recursive: true })
    await git(repository, ['init', '--initial-branch=main'])
    await writeFile(join(repository, 'tracked.txt'), 'original\n')
    await git(repository, ['add', '.'])
    await git(repository, ['commit', '-m', 'baseline'])

    // The work a snapshot exists to preserve.
    await writeFile(join(repository, 'tracked.txt'), 'edited, never committed\n')
    await writeFile(join(repository, 'scratch-notes.md'), 'untracked\n')

    // Decoy one: a repository directory that happens to be called `credentials`.
    await mkdir(join(repository, 'credentials'), { recursive: true })
    await writeFile(join(repository, 'credentials', 'keep.txt'), 'project file, not a secret\n')

    // Conversation state — the half a widened glob would silently drop.
    const logDirectory = sessionLogDirectory(configDir, workspaceRoot)

    await mkdir(logDirectory, { recursive: true })
    await writeFile(
      join(logDirectory, `${SESSION_ID}.jsonl`),
      `${JSON.stringify({ type: 'user', sessionId: SESSION_ID })}\n`,
    )

    // Decoy two: a config file that is not a credential.
    await writeFile(join(configDir, 'settings.json'), '{"theme":"dark"}\n')
    // Decoy three: a sibling whose name starts with the excluded directory's name.
    await writeFile(join(configDir, 'credentials-notes.md'), 'where the credentials came from\n')

    // What `setup.sh` installed, and what must not travel.
    await mkdir(join(configDir, 'credentials'), { recursive: true })
    await writeFile(join(configDir, 'credentials', 'token'), 'a-client-credential\n')

    store = createFakeSnapshotStore()

    const writer = createSnapshotWriter({
      store,
      bucket: 'snapshots.test',
      workflowId: 'wf-under-test',
      now: () => new Date('2026-08-05T09:00:00.000Z'),
    })

    captured = await writer.capture({
      boundary: 'interruption',
      sessionId: SESSION_ID,
      workspaceRoot,
    })

    // Read the members back out of what was actually uploaded, not out of anything the writer said.
    const uploaded = store.bytesAt(`snapshots.test/${captured.s3Key}`)

    if (uploaded === undefined) {
      throw new Error('the writer uploaded nothing')
    }

    const archivePath = join(scratch, 'downloaded.tar.zst')
    const tarPath = join(scratch, 'downloaded.tar')

    await writeFile(archivePath, uploaded)
    await pipeline(
      createReadStream(archivePath),
      createZstdDecompress(),
      createWriteStream(tarPath),
    )

    members = await listArchiveMembers(tarPath)
  }, 60_000)

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  it('uploads exactly one object, under the partitioned key', () => {
    expect(store.keys()).toStrictEqual([`snapshots.test/${captured.s3Key}`])
    expect(captured.s3Key).toContain('snapshots/wf-under-test/')
    expect(captured.s3Key.endsWith('.tar.zst')).toBe(true)
    expect(captured.sizeBytes).toBeGreaterThan(0)
  })

  it('never carries credential material (FR-072)', () => {
    expect(containsCredentialMaterial(members)).toBe(false)
    expect(members.some((member) => member.endsWith('/.agent-config/credentials/token'))).toBe(
      false,
    )
  })

  it('still carries the conversation log — the widened-glob canary (FR-051)', () => {
    expect(members.some((member) => member.endsWith(`${SESSION_ID}.jsonl`))).toBe(true)
    expect(captured.hasConversationState).toBe(true)
  })

  it('keeps a config file that is not a credential', () => {
    expect(members.some((member) => member.endsWith('/.agent-config/settings.json'))).toBe(true)
  })

  it('keeps a sibling whose name merely starts with “credentials”', () => {
    expect(members.some((member) => member.endsWith('/.agent-config/credentials-notes.md'))).toBe(
      true,
    )
  })

  it('keeps a repository directory that happens to be called “credentials”', () => {
    expect(members.some((member) => member.endsWith('/primary/credentials/keep.txt'))).toBe(true)
  })

  it('carries every entry’s working tree and its .git (FR-050)', () => {
    expect(members.some((member) => member.includes('/primary/.git/'))).toBe(true)
    expect(members.some((member) => member.endsWith('/primary/tracked.txt'))).toBe(true)
    expect(members.some((member) => member.endsWith('/primary/scratch-notes.md'))).toBe(true)
    expect(captured.hasWorktreeState).toBe(true)
  })

  it('leaves no scratch archive behind — the tar is the snapshot in plain form', async () => {
    const store2 = createFakeSnapshotStore()
    const holding = await mkdtemp(join(tmpdir(), 'sisyphus-snapshot-scratch-'))

    const writer = createSnapshotWriter({
      store: store2,
      bucket: 'snapshots.test',
      workflowId: 'wf-under-test',
      scratchDir: holding,
    })

    await writer.capture({ boundary: 'pause', sessionId: SESSION_ID, workspaceRoot })

    const { readdir } = await import('node:fs/promises')

    await expect(readdir(holding)).resolves.toStrictEqual([])

    await rm(holding, { recursive: true, force: true })
  }, 60_000)

  it('rejects rather than retrying when the store is unreachable — parking is suspend’s job', async () => {
    const failing = createFakeSnapshotStore()

    failing.failNext(1)

    const writer = createSnapshotWriter({
      store: failing,
      bucket: 'snapshots.test',
      workflowId: 'wf-under-test',
    })

    await expect(
      writer.capture({ boundary: 'stop', sessionId: SESSION_ID, workspaceRoot }),
    ).rejects.toThrow(/unreachable/)
    expect(failing.keys()).toStrictEqual([])
  }, 60_000)
})
