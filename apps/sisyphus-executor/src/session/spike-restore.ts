/**
 * Spike S2 (T012) — cross-instance snapshot restore.
 *
 * The question: does a snapshot taken on instance A restore correctly on
 * instance B — the session is findable at the pinned path so `--resume` has
 * something to resume, uncommitted work is present, and a deliberately
 * truncated final line in the append-only conversation log is discarded rather
 * than being fatal (FR-050, FR-051, FR-053)?
 *
 * Instance identity is simulated by directory, not by machine. What makes the
 * simulation worth anything is that it does **not** cheat on the property
 * under test: R2 says a restore works because the workspace root is a fixed
 * absolute path, so both halves of this spike use the **same** absolute pinned
 * root, and the root is destroyed between them. Instance A builds it, archives
 * it and is torn down; instance B unpacks the archive back to the identical
 * path and reads it fresh. Two side-by-side directories with different
 * absolute paths would have quietly tested something easier.
 *
 * What that does not prove is listed in SPIKE-FINDINGS.md — briefly: nothing
 * about instance metadata, reclamation notices, or the real agent's own
 * behaviour on resume.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { gitFixtureEnvironment } from '../git-fixture-environment'

import {
  discoverSessionIds,
  mangleWorkspacePath,
  parseConversationLog,
  sessionLogDirectory,
} from './conversation-log'

const run = promisify(execFile)

/**
 * The four functions this spike was written to prove now live in `./conversation-log.ts`, which is
 * what the restore path imports. They are re-exported here unchanged so the harness still runs
 * against exactly what production runs against, rather than against a copy that agrees today.
 */
export { discoverSessionIds, mangleWorkspacePath, parseConversationLog, sessionLogDirectory }
export type { ConversationLog } from './conversation-log'

export interface RestoreSpikeOptions {
  /** Session identifier assigned by the control plane, as FR-052 requires. */
  readonly sessionId?: string
  /** Conversation entries written before the truncated final line. */
  readonly intactEntryCount?: number
  /** Keep the scratch directory for inspection instead of removing it. */
  readonly keepScratch?: boolean
}

export interface RestoreSpikeOutcome {
  /** The single absolute path both simulated instances used. */
  readonly pinnedRoot: string
  /** Directory name the agent derives from that path. */
  readonly mangledDirectoryName: string
  /** `zstd` when available, otherwise an uncompressed tar. Recorded, not assumed. */
  readonly compression: 'zstd' | 'none'
  readonly archiveBytes: number
  /** True if the pinned root was genuinely absent between archive and restore. */
  readonly rootDestroyedBetweenInstances: boolean
  /** Session identifiers instance B could find at the pinned path. */
  readonly sessionIdsFoundOnB: readonly string[]
  /** Committed file, unchanged — the baseline the working tree diverges from. */
  readonly committedFilePresent: boolean
  /** Uncommitted edit to a tracked file survived the round trip. */
  readonly modifiedFileContentsOnB: string
  /** Untracked file survived the round trip. */
  readonly untrackedFilePresentOnB: boolean
  /** Porcelain status lines instance B sees; proves `.git` came across intact. */
  readonly gitStatusOnB: readonly string[]
  readonly conversationLinesOnA: number
  readonly conversationEntriesOnB: number
  readonly truncationRepaired: boolean
  /** FR-072: credential material installed by `setup.sh` is not in the archive. */
  readonly credentialExcludedFromArchive: boolean
}

/**
 * The child's whole environment, composed rather than merged over `process.env`.
 *
 * The harness builds a real repository in a temporary directory, so it must not inherit one. Under
 * a git hook `process.env` carries `GIT_DIR` and `GIT_INDEX_FILE` pointing at the repository the
 * hook is running in, and a merge cannot remove them — `git init` below would then re-initialise
 * that repository and the spike would archive somebody else's working tree. See
 * `../git-fixture-environment.ts`.
 */
const gitEnv = gitFixtureEnvironment({
  GIT_AUTHOR_NAME: 'spike',
  GIT_AUTHOR_EMAIL: 'spike@example.invalid',
  GIT_COMMITTER_NAME: 'spike',
  GIT_COMMITTER_EMAIL: 'spike@example.invalid',
})

const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await run('git', [...args], { cwd, env: gitEnv })

  return stdout
}

const hasZstd = async (): Promise<boolean> => {
  try {
    await run('zstd', ['--version'])

    return true
  } catch {
    return false
  }
}

/**
 * Run the spike once and report what was observed.
 *
 * The archive is a real `tar` of the pinned root, compressed with real `zstd`
 * where the tool is present, and the credential subtree is excluded at pack
 * time rather than deleted afterwards — deleting afterwards would mean the
 * secret existed in the archive for a while, which is the thing FR-072
 * forbids.
 */
export const runRestoreSpike = async (
  options: RestoreSpikeOptions = {},
): Promise<RestoreSpikeOutcome> => {
  const sessionId = options.sessionId ?? '11111111-2222-4333-8444-555555555555'
  const intactEntryCount = options.intactEntryCount ?? 4

  const scratch = await mkdtemp(join(tmpdir(), 'sisyphus-restore-spike-'))

  try {
    // One absolute path, used by both simulated instances. In production this
    // is `/workspace`; here it is pinned relative to a per-run scratch root,
    // because a test cannot create `/workspace`. The property under test —
    // that both instances see the **same** absolute path — is preserved.
    const pinnedRoot = join(scratch, 'workspace')
    const configDir = join(pinnedRoot, '.agent-config')
    const outbox = join(scratch, 'instance-a-outbox')
    const inbox = join(scratch, 'instance-b-inbox')
    const repositoryPath = join(pinnedRoot, 'primary')
    const logDirectory = sessionLogDirectory(configDir, pinnedRoot)

    await mkdir(outbox, { recursive: true })
    await mkdir(inbox, { recursive: true })

    // ---- Instance A: build the workspace ------------------------------------
    await mkdir(repositoryPath, { recursive: true })
    await git(repositoryPath, ['init', '--initial-branch=main'])
    await writeFile(join(repositoryPath, 'committed.txt'), 'committed baseline\n')
    await writeFile(join(repositoryPath, 'tracked.txt'), 'original tracked contents\n')
    await git(repositoryPath, ['add', '.'])
    await git(repositoryPath, ['commit', '-m', 'baseline'])

    // The work a snapshot exists to preserve: an edit that was never committed
    // and a file that was never added. Losing either is losing the run.
    const modifiedContents = 'edited by the agent, never committed\n'

    await writeFile(join(repositoryPath, 'tracked.txt'), modifiedContents)
    await writeFile(join(repositoryPath, 'scratch-notes.md'), 'untracked working notes\n')

    await mkdir(logDirectory, { recursive: true })

    const intactLines = Array.from({ length: intactEntryCount }, (_unused, index) =>
      JSON.stringify({ type: 'user', sessionId, sequence: index, cwd: pinnedRoot }),
    )
    // Deliberately truncated: a crash part-way through an append leaves exactly
    // this, and restore has to treat it as ordinary rather than fatal.
    const truncatedTail = '{"type":"assistant","sessionId":"' + sessionId + '","content":[{"ty'
    const logContents = `${intactLines.join('\n')}\n${truncatedTail}`

    await writeFile(join(logDirectory, `${sessionId}.jsonl`), logContents)

    // Installed by `setup.sh`, and excluded from the archive on purpose.
    const credentialDirectory = join(configDir, 'credentials')

    await mkdir(credentialDirectory, { recursive: true })
    await writeFile(join(credentialDirectory, 'token'), 'a-client-credential\n')

    // ---- Instance A: archive -------------------------------------------------
    const tarPath = join(outbox, 'snapshot.tar')

    await run('tar', [
      '--create',
      '--file',
      tarPath,
      '--exclude',
      './workspace/.agent-config/credentials',
      '--directory',
      dirname(pinnedRoot),
      './workspace',
    ])

    const compression: 'zstd' | 'none' = (await hasZstd()) ? 'zstd' : 'none'
    let archivePath = tarPath

    if (compression === 'zstd') {
      archivePath = `${tarPath}.zst`
      await run('zstd', ['--quiet', '--force', '--rm', tarPath, '-o', archivePath])
    }

    const archiveBytes = (await readFile(archivePath)).byteLength

    // ---- Instance A is destroyed --------------------------------------------
    await rm(pinnedRoot, { recursive: true, force: true })

    const rootDestroyedBetweenInstances = !existsSync(pinnedRoot)

    // ---- Instance B: restore to the identical absolute path ------------------
    const deliveredPath = join(
      inbox,
      archivePath.endsWith('.zst') ? 'snapshot.tar.zst' : 'snapshot.tar',
    )

    await writeFile(deliveredPath, await readFile(archivePath))

    let restoreTarPath = deliveredPath

    if (compression === 'zstd') {
      restoreTarPath = join(inbox, 'snapshot.tar')
      await run('zstd', ['--quiet', '--force', '--decompress', deliveredPath, '-o', restoreTarPath])
    }

    await run('tar', ['--extract', '--file', restoreTarPath, '--directory', dirname(pinnedRoot)])

    // ---- Instance B: verify --------------------------------------------------
    const sessionIdsFoundOnB = await discoverSessionIds(logDirectory)
    const restoredLog = parseConversationLog(
      await readFile(join(logDirectory, `${sessionId}.jsonl`), 'utf8'),
    )
    const status = await git(repositoryPath, ['status', '--porcelain'])

    return {
      pinnedRoot,
      mangledDirectoryName: mangleWorkspacePath(pinnedRoot),
      compression,
      archiveBytes,
      rootDestroyedBetweenInstances,
      sessionIdsFoundOnB,
      committedFilePresent: existsSync(join(repositoryPath, 'committed.txt')),
      modifiedFileContentsOnB: await readFile(join(repositoryPath, 'tracked.txt'), 'utf8'),
      untrackedFilePresentOnB: existsSync(join(repositoryPath, 'scratch-notes.md')),
      gitStatusOnB: status
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== ''),
      conversationLinesOnA: intactLines.length + 1,
      conversationEntriesOnB: restoredLog.entries.length,
      truncationRepaired: restoredLog.truncationRepaired,
      credentialExcludedFromArchive: !existsSync(join(credentialDirectory, 'token')),
    }
  } finally {
    if (options.keepScratch !== true) {
      await rm(scratch, { recursive: true, force: true })
    }
  }
}
