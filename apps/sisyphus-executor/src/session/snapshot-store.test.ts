import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  codedError,
  createFakeSnapshotStore,
  isCodedError,
  SNAPSHOT_NOT_FOUND,
  SNAPSHOT_STORE_UNREACHABLE,
} from './snapshot-store'

/**
 * The fake is used by three suites, so it is worth asserting that it behaves like the thing it
 * stands in for — in particular that "nothing is stored there" and "the store is unreachable" are
 * different conditions. One is worth parking and retrying on (FR-082); the other never will be, and
 * a fake that conflated them would let a restore park for two minutes against a key that does not
 * exist.
 */

const scratches: string[] = []

const scratch = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), 'sisyphus-snapshot-store-'))

  scratches.push(path)

  return path
}

afterEach(async () => {
  await Promise.all(scratches.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('codedError', () => {
  it('tags a plain Error, because instanceof across a bundler boundary is fragile', () => {
    const error = codedError(SNAPSHOT_NOT_FOUND, 'nothing there')

    expect(isCodedError(error, SNAPSHOT_NOT_FOUND)).toBe(true)
    expect(isCodedError(error, SNAPSHOT_STORE_UNREACHABLE)).toBe(false)
    expect(isCodedError('not an error', SNAPSHOT_NOT_FOUND)).toBe(false)
  })
})

describe('createFakeSnapshotStore', () => {
  it('round-trips an archive through a key', async () => {
    const store = createFakeSnapshotStore()
    const directory = await scratch()
    const source = join(directory, 'snapshot.tar.zst')

    await writeFile(source, 'archive bytes')
    await store.put({ bucket: 'b', key: 'snapshots/one' }, source)

    const destination = join(directory, 'downloaded', 'snapshot.tar.zst')

    await store.get({ bucket: 'b', key: 'snapshots/one' }, destination)

    await expect(readFile(destination, 'utf8')).resolves.toBe('archive bytes')
    expect(store.keys()).toStrictEqual(['b/snapshots/one'])
  })

  it('creates the directory a download is asked for, as an object store client would', async () => {
    const store = createFakeSnapshotStore()
    const directory = await scratch()
    const source = join(directory, 'snapshot.tar.zst')

    await writeFile(source, 'x')
    await store.put({ bucket: 'b', key: 'k' }, source)

    const nested = join(directory, 'deep', 'deeper', 'snapshot.tar.zst')

    await store.get({ bucket: 'b', key: 'k' }, nested)

    expect(existsSync(nested)).toBe(true)
  })

  it('reports a missing object as not found, which is never worth a retry', async () => {
    const store = createFakeSnapshotStore()
    const directory = await scratch()

    const failure = await store
      .get({ bucket: 'b', key: 'absent' }, join(directory, 'out'))
      .catch((caught: unknown) => caught)

    expect(isCodedError(failure, SNAPSHOT_NOT_FOUND)).toBe(true)
  })

  it('reports an injected failure as unreachable, which is (FR-082)', async () => {
    const store = createFakeSnapshotStore()
    const directory = await scratch()
    const source = join(directory, 'snapshot.tar.zst')

    await writeFile(source, 'x')
    store.failNext(1)

    const failure = await store
      .put({ bucket: 'b', key: 'k' }, source)
      .catch((caught: unknown) => caught)

    expect(isCodedError(failure, SNAPSHOT_STORE_UNREACHABLE)).toBe(true)
    expect(store.keys()).toStrictEqual([])
  })

  it('fails exactly as many times as it was told to, so a park budget is testable', async () => {
    const store = createFakeSnapshotStore()
    const directory = await scratch()
    const source = join(directory, 'snapshot.tar.zst')

    await writeFile(source, 'x')
    store.failNext(2)

    await expect(store.put({ bucket: 'b', key: 'k' }, source)).rejects.toThrow()
    await expect(store.put({ bucket: 'b', key: 'k' }, source)).rejects.toThrow()
    await expect(store.put({ bucket: 'b', key: 'k' }, source)).resolves.toBeUndefined()
  })
})
