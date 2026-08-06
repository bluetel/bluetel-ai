/**
 * **Where a session snapshot is put and got (T097, T098, FR-050, FR-071, FR-082).**
 *
 * Two methods with object storage behind them, for the same reason `bootstrap/archive-store.ts` is
 * shaped this way: a snapshot path that talks to `S3Client` directly can only be exercised by
 * creating a real bucket, and a test that creates a real bucket is a test nobody runs. Everything
 * that is actually interesting about T097 and T098 — that the credential subtree never enters the
 * archive, that a truncated final line is ordinary, that a snapshot without a worktree is refused
 * before the agent is told the instance is ready — is decided above this interface and proved
 * against {@link createFakeSnapshotStore}.
 *
 * ## Paths rather than bytes
 *
 * `put` and `get` take a **local file path**, not a `Uint8Array`, and that differs deliberately
 * from the bundle archive store. A setup bundle is a few megabytes of installer; a snapshot is a
 * whole workspace, `.git` directories included, and buffering one in memory on an instance that is
 * about to be reclaimed is the wrong place to discover the limit. The path also lets `tar` write
 * straight to disk and the upload stream from it.
 *
 * ## Failure is expected, not exceptional
 *
 * A rejected `put` is the FR-082 case: `suspend()` hands this to `parkAndRetry`, the run holds at
 * the turn boundary it already reached, and no token is spent while storage comes back. So the
 * fake can be told to fail a fixed number of times — that path needs exercising with something
 * more honest than a throwing stub written inline in one test.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** One object, addressed the way the platform partitions snapshots per workflow (FR-071). */
export interface SnapshotLocation {
  readonly bucket: string
  readonly key: string
}

export interface SnapshotObjectStore {
  /** Upload the archive sitting at `filePath`. */
  readonly put: (location: SnapshotLocation, filePath: string) => Promise<void>
  /**
   * Download to `filePath`.
   *
   * Rejects with {@link SNAPSHOT_NOT_FOUND} when nothing is stored there — which is a different
   * condition from a transient failure and must stay distinguishable, because one is worth
   * retrying and the other never will be.
   */
  readonly get: (location: SnapshotLocation, filePath: string) => Promise<void>
}

/** Nothing is stored under that key. Retrying will not change that. */
export const SNAPSHOT_NOT_FOUND = 'E_SESSION_SNAPSHOT_MISSING'

/** The store was unreachable. This is the condition FR-082 parks and retries on. */
export const SNAPSHOT_STORE_UNREACHABLE = 'E_SNAPSHOT_STORE_UNREACHABLE'

export interface CodedError extends Error {
  readonly code: string
}

/** A tagged plain `Error`: `instanceof` across a bundler boundary is fragile. */
export const codedError = (code: string, message: string): CodedError =>
  Object.assign(new Error(message), { code })

export const isCodedError = (error: unknown, code: string): boolean =>
  error instanceof Error && (error as Partial<CodedError>).code === code

const locationKey = (location: SnapshotLocation): string => `${location.bucket}/${location.key}`

/** A fake store, plus the handful of controls its tests need. */
export interface FakeSnapshotStore extends SnapshotObjectStore {
  /** Every key written, in write order. */
  readonly keys: () => readonly string[]
  /** The bytes stored under a key, for an assertion about what was actually uploaded. */
  readonly bytesAt: (key: string) => Uint8Array | undefined
  /** Make the next `count` calls fail as unreachable, so the park path is exercised for real. */
  readonly failNext: (count: number) => void
}

/**
 * An in-memory store for tests.
 *
 * Lives beside the interface rather than in a test file because `snapshot.test.ts`,
 * `restore.test.ts` and `interruption.test.ts` all need one, and a fake copied into three test
 * files is three fakes that drift.
 */
export const createFakeSnapshotStore = (): FakeSnapshotStore => {
  const objects = new Map<string, Uint8Array>()
  const written: string[] = []
  let failures = 0

  const consumeFailure = (): void => {
    if (failures > 0) {
      failures -= 1

      throw codedError(SNAPSHOT_STORE_UNREACHABLE, 'the snapshot store is unreachable')
    }
  }

  return {
    put: async (location, filePath) => {
      consumeFailure()

      const key = locationKey(location)

      objects.set(key, await readFile(filePath))
      written.push(key)
    },

    get: async (location, filePath) => {
      consumeFailure()

      const bytes = objects.get(locationKey(location))

      if (bytes === undefined) {
        throw codedError(SNAPSHOT_NOT_FOUND, `no snapshot at ${locationKey(location)}`)
      }

      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, bytes)
    },

    keys: () => [...written],
    bytesAt: (key) => objects.get(key),
    failNext: (count) => {
      failures = count
    },
  }
}
