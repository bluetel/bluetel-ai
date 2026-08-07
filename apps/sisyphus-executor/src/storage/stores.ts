/**
 * The three object stores the run needs, built on one seam (T173).
 *
 * Each of these satisfies an interface that already existed and already had a fake behind it. What
 * they add is the half FR-203 was missing: a real implementation, reachable from the entry point,
 * so the bundle actually downloads, the log actually persists and the snapshot actually survives
 * the instance.
 *
 * They are three functions rather than one general-purpose store because the three have genuinely
 * different failure vocabularies, and flattening them would lose the distinction the callers act
 * on. A missing bundle archive is `E_BUNDLE_ARCHIVE_MISSING` and is not retryable — the bytes are
 * not there and asking again produces the same answer. A missing snapshot is
 * `E_SESSION_SNAPSHOT_MISSING`, which a restore reports differently from
 * `E_SNAPSHOT_STORE_UNREACHABLE`, which is exactly the condition `parkAndRetry` holds the run
 * open for (FR-082). A segment write has no missing case at all, because it only ever puts.
 */

import type { BundleArchiveStore } from '../bootstrap'
import { ARCHIVE_NOT_FOUND, codedError as archiveError } from '../bootstrap'
import type { SegmentStore } from '../output'
import type { SnapshotObjectStore } from '../session'
import {
  codedError as snapshotError,
  SNAPSHOT_NOT_FOUND,
  SNAPSHOT_STORE_UNREACHABLE,
} from '../session'

import type { S3Operations } from './client'

export interface BucketBackedStoreOptions {
  readonly operations: S3Operations
  readonly bucket: string
}

/**
 * Where bootstrap phase 2 reads the setup bundle from.
 *
 * The bucket is fixed at construction and the key comes from the envelope, which is what keeps a
 * job envelope from being able to name a bucket: the archive location is half instance
 * configuration and half job parameter, and only the job half is attacker-adjacent.
 */
export const createS3BundleArchiveStore = (
  options: BucketBackedStoreOptions,
): BundleArchiveStore => ({
  get: async (location) => {
    const bytes = await options.operations.getBytes(location)

    if (bytes === undefined) {
      throw archiveError(
        ARCHIVE_NOT_FOUND,
        `no setup bundle archive at ${location.bucket}/${location.key}`,
      )
    }

    return bytes
  },
})

/**
 * Where the output pipeline persists each sanitised segment (FR-046).
 *
 * Takes `SanitisedText` and nothing else, which is the property `output/sanitise.ts` engineered:
 * an unsanitised string will not type-check here, so a copy of raw agent output cannot reach
 * durable storage by anybody forgetting a step.
 */
export const createS3SegmentStore = (options: BucketBackedStoreOptions): SegmentStore => ({
  put: async ({ key, body }) => {
    await options.operations.putBytes(
      { bucket: options.bucket, key },
      new TextEncoder().encode(body),
    )
  },
})

/**
 * Where a session snapshot goes and comes back from (FR-050, FR-053, FR-082).
 *
 * Both methods take a local path rather than bytes; see `session/snapshot-store.ts` for why. The
 * `put` deliberately does **not** retry: `suspend()` hands a rejection to `parkAndRetry`, which
 * holds the run at the turn boundary `quiesce` already reached and has a budget of its own. A
 * retry loop here would be a second one running underneath the first with a different idea of how
 * long is too long.
 */
export const createS3SnapshotStore = (options: BucketBackedStoreOptions): SnapshotObjectStore => ({
  put: async (location, filePath) => {
    try {
      await options.operations.putFile(location, filePath)
    } catch (cause) {
      throw snapshotError(
        SNAPSHOT_STORE_UNREACHABLE,
        `could not write the snapshot to ${location.bucket}/${location.key}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      )
    }
  },

  get: async (location, filePath) => {
    const found = await options.operations.getFile(location, filePath)

    if (!found) {
      throw snapshotError(
        SNAPSHOT_NOT_FOUND,
        `no session snapshot at ${location.bucket}/${location.key}`,
      )
    }
  },
})
