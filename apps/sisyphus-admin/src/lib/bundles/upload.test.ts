import { gzipSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { sha256Base64, sha256Hex } from './digest'
import { createFakeObjectStore } from './fake-object-store'
import { isCodedError } from './object-store'
import {
  ARCHIVE_DIGEST_MISMATCH,
  ARCHIVE_EMPTY,
  ARCHIVE_NOT_GZIP,
  ARCHIVE_TOO_LARGE,
  MAX_ARCHIVE_BYTES,
  uploadBundleArchive,
} from './upload'

const BUCKET = 'sisyphus-bundles'

/** A plausible archive. Real gzip, so the format check is exercised rather than stubbed. */
const archive = (contents: string): Uint8Array => new Uint8Array(gzipSync(Buffer.from(contents)))

const upload = (bytes: Uint8Array, store = createFakeObjectStore(), uploadId?: string) =>
  uploadBundleArchive({ store, bucket: BUCKET, bundleName: 'Acme Client', bytes, uploadId })

describe('uploadBundleArchive', () => {
  it('reports the key, the digest and the size the register call needs', async () => {
    const bytes = archive('#!/bin/sh\nexit 0\n')
    const result = await upload(bytes)

    expect(result.contentDigest).toBe(sha256Hex(bytes))
    expect(result.sizeBytes).toBe(bytes.length)
    expect(result.s3Key).toMatch(/^bundles\/acme-client\/.+\.tar\.gz$/)
  })

  it('computes the digest from the bytes it stored, not from what the caller claimed', async () => {
    const store = createFakeObjectStore()
    const bytes = archive('setup')

    const result = await uploadBundleArchive({
      store,
      bucket: BUCKET,
      bundleName: 'Acme',
      bytes,
      declaredDigest: sha256Hex(bytes),
    })

    const stored = await store.get({ bucket: BUCKET, key: result.s3Key })

    // The recorded digest is the digest of what came back out of storage. That is the whole
    // contract with the executor's `bundle_verify` phase: it downloads this object and re-hashes
    // it, so a digest taken from anywhere else is a digest of something else.
    expect(sha256Hex(stored)).toBe(result.contentDigest)
  })

  it('refuses when the claimed digest disagrees, rather than recording the claim', async () => {
    await expect(
      uploadBundleArchive({
        store: createFakeObjectStore(),
        bucket: BUCKET,
        bundleName: 'Acme',
        bytes: archive('setup'),
        declaredDigest: 'f'.repeat(64),
      }),
    ).rejects.toSatisfy((error: unknown) => isCodedError(error, ARCHIVE_DIGEST_MISMATCH))
  })

  it('stores the archive encrypted, refusing to overwrite, with the checksum alongside (FR-084)', async () => {
    const store = createFakeObjectStore()
    const bytes = archive('setup')
    await upload(bytes, store)

    expect(store.puts).toHaveLength(1)
    const [put] = store.puts
    expect(put.encryption.algorithm).toBe('aws:kms')
    expect(put.refuseOverwrite).toBe(true)
    expect(put.checksumSha256).toBe(sha256Base64(bytes))
    expect(put.bucket).toBe(BUCKET)
  })

  it('gives the same archive a new key every time, so a re-registration cannot overwrite (FR-090)', async () => {
    const store = createFakeObjectStore()
    const bytes = archive('identical contents')

    const first = await upload(bytes, store)
    const second = await upload(bytes, store)

    // Identical bytes, identical digest — and two different objects. This is what makes
    // "replacement creates a version" true at the storage layer rather than only in the database:
    // there is no key for the second upload to land on.
    expect(second.contentDigest).toBe(first.contentDigest)
    expect(second.s3Key).not.toBe(first.s3Key)
    expect(store.keys()).toHaveLength(2)

    // And the first archive is still readable, byte for byte.
    await expect(store.get({ bucket: BUCKET, key: first.s3Key })).resolves.toEqual(bytes)
  })

  it('keeps the first archive intact when a replacement carries different contents', async () => {
    const store = createFakeObjectStore()
    const original = archive('version one')
    const replacement = archive('version two')

    const first = await upload(original, store)
    const second = await upload(replacement, store)

    await expect(store.get({ bucket: BUCKET, key: first.s3Key })).resolves.toEqual(original)
    await expect(store.get({ bucket: BUCKET, key: second.s3Key })).resolves.toEqual(replacement)
    expect(first.contentDigest).not.toBe(second.contentDigest)
  })

  it('lets the store refuse an overwrite if the key derivation is ever weakened', async () => {
    const store = createFakeObjectStore()
    const bytes = archive('setup')

    // Forcing the same upload id is the only way to produce a collision, and it stands in for a
    // future regression in `bundleArchiveKey`. The write is refused rather than replacing the
    // stored archive — the second of the two immutability mechanisms.
    await upload(bytes, store, 'fixed-upload-id')
    await expect(upload(bytes, store, 'fixed-upload-id')).rejects.toThrow()

    expect(store.keys()).toHaveLength(1)
  })

  it('refuses an empty file with a code and a next action', async () => {
    await expect(upload(new Uint8Array())).rejects.toSatisfy((error: unknown) =>
      isCodedError(error, ARCHIVE_EMPTY),
    )
  })

  it('refuses something that is not a gzipped tar', async () => {
    await expect(upload(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]))).rejects.toSatisfy(
      (error: unknown) => isCodedError(error, ARCHIVE_NOT_GZIP),
    )
  })

  it('refuses an archive past the ceiling before hashing or storing it', async () => {
    const store = createFakeObjectStore()
    const oversized = new Uint8Array(MAX_ARCHIVE_BYTES + 1)
    oversized[0] = 0x1f
    oversized[1] = 0x8b

    await expect(upload(oversized, store)).rejects.toSatisfy((error: unknown) =>
      isCodedError(error, ARCHIVE_TOO_LARGE),
    )
    expect(store.puts).toHaveLength(0)
  })

  it('never stores anything when a check refuses', async () => {
    const store = createFakeObjectStore()

    await upload(new Uint8Array(), store).catch(() => undefined)
    await upload(Uint8Array.from([1, 2, 3]), store).catch(() => undefined)

    expect(store.puts).toHaveLength(0)
    expect(store.keys()).toHaveLength(0)
  })
})
