import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ARCHIVE_NOT_FOUND, isCodedError as isArchiveCodedError } from '../bootstrap'
import { EMPTY_SANITISED_TEXT, sanitise } from '../output'
import {
  isCodedError as isSnapshotCodedError,
  SNAPSHOT_NOT_FOUND,
  SNAPSHOT_STORE_UNREACHABLE,
} from '../session'

import type { ObjectLocation, S3Operations } from './client'
import { createS3BundleArchiveStore, createS3SegmentStore, createS3SnapshotStore } from './stores'

/**
 * The three stores, against a fake `S3Operations` (T173).
 *
 * The assertions worth having are about the failure vocabulary. Each store's callers act on a
 * different code — a missing bundle is not retryable, an unreachable snapshot store is the FR-082
 * park condition — so a store that reported one condition as the other would be a defect that no
 * happy-path test could see.
 */

interface FakeOperations extends S3Operations {
  readonly written: Map<string, Uint8Array>
  readonly files: Map<string, string>
}

const fakeOperations = (
  options: {
    readonly objects?: Readonly<Record<string, string>>
    readonly failPut?: boolean
  } = {},
): FakeOperations => {
  const objects = new Map(Object.entries(options.objects ?? {}))
  const written = new Map<string, Uint8Array>()
  const files = new Map<string, string>()
  const at = (location: ObjectLocation): string => `${location.bucket}/${location.key}`

  return {
    written,
    files,
    getBytes: async (location) => {
      const value = objects.get(at(location))

      return Promise.resolve(value === undefined ? undefined : new TextEncoder().encode(value))
    },
    putBytes: async (location, bytes) => {
      written.set(at(location), bytes)

      return Promise.resolve()
    },
    putFile: async (location, filePath) => {
      if (options.failPut === true) {
        return Promise.reject(new Error('the bucket is unreachable'))
      }

      files.set(at(location), filePath)

      return Promise.resolve()
    },
    getFile: async (location) => Promise.resolve(objects.has(at(location))),
  }
}

describe('createS3BundleArchiveStore', () => {
  it('answers the archive bytes', async () => {
    const operations = fakeOperations({ objects: { 'bundles/acme/3.tar.zst': 'archive' } })
    const store = createS3BundleArchiveStore({ operations, bucket: 'bundles' })

    const bytes = await store.get({ bucket: 'bundles', key: 'acme/3.tar.zst' })

    expect(new TextDecoder().decode(bytes)).toBe('archive')
  })

  it('raises the not-found code the bootstrap path treats as non-retryable (FR-088)', async () => {
    const store = createS3BundleArchiveStore({ operations: fakeOperations(), bucket: 'bundles' })

    const failure = await store
      .get({ bucket: 'bundles', key: 'gone' })
      .catch((error: unknown) => error)

    expect(isArchiveCodedError(failure, ARCHIVE_NOT_FOUND)).toBe(true)
  })
})

describe('createS3SegmentStore', () => {
  it('writes sanitised text under the key the segment writer chose', async () => {
    const operations = fakeOperations()
    const store = createS3SegmentStore({ operations, bucket: 'logs' })

    await store.put({ key: 'workflows/w/000001.txt', body: sanitise('one line') })

    expect(new TextDecoder().decode(operations.written.get('logs/workflows/w/000001.txt'))).toBe(
      'one line',
    )
  })

  it('writes an empty segment without inventing content for it', async () => {
    const operations = fakeOperations()
    const store = createS3SegmentStore({ operations, bucket: 'logs' })

    await store.put({ key: 'workflows/w/000002.txt', body: EMPTY_SANITISED_TEXT })

    expect(operations.written.get('logs/workflows/w/000002.txt')).toHaveLength(0)
  })
})

describe('createS3SnapshotStore', () => {
  it('streams the archive up from its path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sisyphus-store-'))
    const path = join(directory, 'snapshot.tar.zst')
    await writeFile(path, 'snapshot', 'utf8')

    const operations = fakeOperations()
    const store = createS3SnapshotStore({ operations, bucket: 'snapshots' })

    await store.put({ bucket: 'snapshots', key: 'w/1.tar.zst' }, path)

    expect(operations.files.get('snapshots/w/1.tar.zst')).toBe(path)
  })

  it('raises the unreachable code suspend() parks on, not a bare error (FR-082)', async () => {
    const operations = fakeOperations({ failPut: true })
    const store = createS3SnapshotStore({ operations, bucket: 'snapshots' })

    const failure = await store
      .put({ bucket: 'snapshots', key: 'w/1.tar.zst' }, '/tmp/nothing')
      .catch((error: unknown) => error)

    expect(isSnapshotCodedError(failure, SNAPSHOT_STORE_UNREACHABLE)).toBe(true)
    expect(String(failure)).toContain('the bucket is unreachable')
  })

  it('distinguishes a snapshot that is not there from a store that is not answering', async () => {
    const store = createS3SnapshotStore({ operations: fakeOperations(), bucket: 'snapshots' })

    const failure = await store
      .get({ bucket: 'snapshots', key: 'gone' }, '/tmp/nothing')
      .catch((error: unknown) => error)

    expect(isSnapshotCodedError(failure, SNAPSHOT_NOT_FOUND)).toBe(true)
    expect(isSnapshotCodedError(failure, SNAPSHOT_STORE_UNREACHABLE)).toBe(false)
  })
})
