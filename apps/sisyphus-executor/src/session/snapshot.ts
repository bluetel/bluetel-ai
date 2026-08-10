/**
 * **The snapshot writer (T097, FR-050, FR-051, FR-071, FR-072, R2).**
 *
 * One `tar.zst` of the pinned root, containing every entry's working tree **and** its `.git` — so
 * uncommitted work and index state survive — plus the agent's conversation state under
 * `.agent-config`. This module implements {@link SnapshotPort}, the one-method seam `suspend()`
 * already declares; it does not know what a pause is, and `suspend()` does not know what a tar is.
 *
 * ## The one exclusion, and why it is at pack time
 *
 * `<root>/.agent-config/credentials/` and nothing else. FR-072 — reaffirmed as 003/FR-013 — forbids
 * a credential appearing in a snapshot in plain text, and the exclusion is passed to `tar` rather
 * than applied by deleting afterwards: deleting afterwards means the secret sat inside the archive
 * for a while, which is the thing being forbidden.
 *
 * **The rule is unchanged from 002; what changed is where the material comes from on the way back
 * in.** In 002 the exclusion cost nothing because bootstrap phases 2–5 re-ran on the restore boot
 * and the setup bundle reinstalled the credentials. Under 003 the bundle installs no agent
 * credential at all (FR-048): the restore boot runs bootstrap phase `credential_install`, which
 * fetches the leased material from the machine surface — and it runs on **every** boot, restore and
 * resumed-instance alike (FR-050), so a snapshot that carries no credential is a snapshot that
 * needs none.
 *
 * The excluded directory is {@link AGENT_CREDENTIAL_DIR_NAME}, the same constant
 * `bootstrap/credential-install.ts` writes into. Deriving both ends from one name is what stops the
 * install path and the exclusion drifting into two spellings of "credentials", which would not be
 * noticed until an archive was opened by hand.
 *
 * The exclusion is deliberately the **credential subtree**, not the config tree. Widening it by one
 * path segment to `.agent-config` would drop the conversation log and produce a snapshot that
 * restores a workspace nobody can explain; `snapshot.test.ts` asserts both halves of that against a
 * real archive, with decoys, so a widened glob fails a test rather than shipping.
 *
 * ## The state flags are derived, not asserted
 *
 * {@link CapturedSnapshot} carries `hasConversationState` and `hasWorktreeState`, and FR-050 makes
 * a snapshot missing either **not resumable**. So they are read back out of the finished archive's
 * member list ({@link snapshotStateFlags}) rather than set to `true` because the code meant to
 * include them. A tar that silently skipped an unreadable `.git` produces `false` here, the
 * machine surface refuses to make the snapshot current (T099), and the failure is visible at
 * registration time instead of at restore time, when the run is already lost.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { AGENT_CONFIG_DIR_NAME, AGENT_CREDENTIAL_DIR_NAME } from '../bootstrap'

import { packWorkspaceArchive } from './snapshot-archive'
import type { SnapshotLocation, SnapshotObjectStore } from './snapshot-store'
import type { CapturedSnapshot, SnapshotPort, SnapshotRequest } from './suspend'

/**
 * The directory bootstrap phase `credential_install` writes credential material into, relative to
 * the pinned root.
 *
 * Composed from the two names `bootstrap/workspace.ts` owns rather than spelled out, so that the
 * path this exclusion protects and the path the installer writes to are the same path by
 * construction (003/FR-013).
 */
export const CREDENTIAL_SUBTREE = `${AGENT_CONFIG_DIR_NAME}/${AGENT_CREDENTIAL_DIR_NAME}`

/** Where conversation logs sit beneath the config tree. Included, unlike their credential sibling. */
export const CONVERSATION_SUBTREE = `${AGENT_CONFIG_DIR_NAME}/projects`

/**
 * The exclusion list, as passed to `tar`.
 *
 * **Exactly one entry, and exactly one path.** It is anchored to the archive member name, so it
 * cannot match a directory called `credentials` inside a checked-out repository — an agent working
 * on a project with a `credentials/` folder would otherwise silently lose it, and would lose it
 * only sometimes, which is worse.
 *
 * Kept as a pure function so the shape of the glob can be asserted without packing anything.
 */
export const snapshotExcludePatterns = (workspaceRoot: string): readonly string[] => [
  `./${basename(workspaceRoot)}/${CREDENTIAL_SUBTREE}`,
]

/** The two facts FR-050 makes a resume depend on. */
export interface SnapshotStateFlags {
  readonly hasConversationState: boolean
  readonly hasWorktreeState: boolean
}

/**
 * Read the state flags out of an archive's member list.
 *
 * Conversation state means at least one session log under `.agent-config/projects/`; worktree state
 * means at least one `.git` directory, because a checkout without one is a bag of files that has
 * forgotten it was ever modified — and uncommitted work is the thing a snapshot exists to keep.
 *
 * @param memberPaths - Members as the finished archive lists them.
 */
export const snapshotStateFlags = (memberPaths: readonly string[]): SnapshotStateFlags => ({
  hasConversationState: memberPaths.some(
    (member) => member.includes(`/${CONVERSATION_SUBTREE}/`) && member.endsWith('.jsonl'),
  ),
  hasWorktreeState: memberPaths.some(
    (member) => member.includes('/.git/') || member.endsWith('/.git'),
  ),
})

/**
 * Whether an archive listing contains anything from the credential subtree (FR-072).
 *
 * Exported because the assertion belongs to whoever is holding the listing, and because a check
 * written inline in one test is a check the next archive-shaped change will not run.
 */
export const containsCredentialMaterial = (memberPaths: readonly string[]): boolean =>
  memberPaths.some((member) => member.includes(`/${CREDENTIAL_SUBTREE}/`))

/**
 * The object key, partitioned per workflow (FR-071).
 *
 * The boundary and the timestamp are both in the name because a workflow has many snapshots and
 * "which one is this" is asked from a bucket listing far more often than from the database.
 */
export const snapshotObjectKey = (options: {
  readonly workflowId: string
  readonly sessionId: string
  readonly boundary: string
  readonly at: Date
}): string => {
  const stamp = options.at.toISOString().replace(/[:.]/g, '-')

  return `snapshots/${options.workflowId}/${options.sessionId}/${stamp}-${options.boundary}.tar.zst`
}

export interface SnapshotWriterOptions {
  readonly store: SnapshotObjectStore
  readonly bucket: string
  /** The run this snapshot belongs to, for the key's partition (FR-071). */
  readonly workflowId: string
  /** Injected so the key is deterministic under test. */
  readonly now?: () => Date
  /** Scratch directory for the tar and the compressed archive. Defaults to the system temp dir. */
  readonly scratchDir?: string
  /** Reported when the archive is written but before it is uploaded, for progress in the log. */
  readonly onPacked?: (packed: { readonly key: string; readonly sizeBytes: number }) => void
}

/**
 * Build the snapshot writer `suspend()` takes as its {@link SnapshotPort}.
 *
 * Nothing here retries. An unreachable store rejects, and `suspend()` hands that to
 * `parkAndRetry`, which holds the run at the turn boundary `quiesce` already reached (FR-082). A
 * retry loop in here would be a second one, running under the first, with its own idea of how long
 * is too long.
 *
 * @param options - See {@link SnapshotWriterOptions}.
 */
export const createSnapshotWriter = (options: SnapshotWriterOptions): SnapshotPort => ({
  capture: async (request: SnapshotRequest): Promise<CapturedSnapshot> => {
    const at = (options.now ?? (() => new Date()))()
    const scratch = await mkdtemp(join(options.scratchDir ?? tmpdir(), 'sisyphus-snapshot-'))

    try {
      const packed = await packWorkspaceArchive({
        workspaceRoot: request.workspaceRoot,
        tarPath: join(scratch, 'snapshot.tar'),
        archivePath: join(scratch, 'snapshot.tar.zst'),
        excludes: snapshotExcludePatterns(request.workspaceRoot),
      })

      const key = snapshotObjectKey({
        workflowId: options.workflowId,
        sessionId: request.sessionId,
        boundary: request.boundary,
        at,
      })

      options.onPacked?.({ key, sizeBytes: packed.sizeBytes })

      const location: SnapshotLocation = { bucket: options.bucket, key }

      await options.store.put(location, packed.archivePath)

      return {
        s3Key: key,
        sizeBytes: packed.sizeBytes,
        ...snapshotStateFlags(packed.memberPaths),
      }
    } finally {
      // The scratch tar is the snapshot in plain form. It goes whether the upload worked or not,
      // and before the park loop's next attempt repacks — a retry that reused a half-written tar
      // would upload an archive nobody packed.
      await rm(scratch, { recursive: true, force: true })
    }
  },
})
