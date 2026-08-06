import { describe, expect, it } from 'vitest'

import { createFakeObjectStore } from './fake-object-store'
import type { PutObjectRequest } from './object-store'
import { isCodedError, OBJECT_ALREADY_EXISTS, OBJECT_NOT_FOUND } from './object-store'

const request = (overrides: Partial<PutObjectRequest> = {}): PutObjectRequest => ({
  bucket: 'bundles',
  key: 'bundles/acme/one.tar.gz',
  body: Uint8Array.from([1, 2, 3]),
  contentType: 'application/gzip',
  checksumSha256: 'checksum',
  encryption: { algorithm: 'aws:kms' },
  refuseOverwrite: true,
  ...overrides,
})

describe('createFakeObjectStore', () => {
  it('stores and returns the bytes it was given', async () => {
    const store = createFakeObjectStore()
    await store.put(request())

    await expect(store.get({ bucket: 'bundles', key: 'bundles/acme/one.tar.gz' })).resolves.toEqual(
      Uint8Array.from([1, 2, 3]),
    )
  })

  it('refuses a second write to the same key, exactly as a conditional put does', async () => {
    const store = createFakeObjectStore()
    await store.put(request())

    await expect(store.put(request({ body: Uint8Array.from([9]) }))).rejects.toSatisfy(
      (error: unknown) => isCodedError(error, OBJECT_ALREADY_EXISTS),
    )

    // The first object is untouched. A fake that let the second write through would make the
    // immutability test in `upload.test.ts` prove nothing.
    await expect(store.get({ bucket: 'bundles', key: 'bundles/acme/one.tar.gz' })).resolves.toEqual(
      Uint8Array.from([1, 2, 3]),
    )
  })

  it('allows an overwrite when the request did not ask to be refused', async () => {
    const store = createFakeObjectStore()
    await store.put(request({ refuseOverwrite: false }))
    await store.put(request({ refuseOverwrite: false, body: Uint8Array.from([9]) }))

    await expect(store.get({ bucket: 'bundles', key: 'bundles/acme/one.tar.gz' })).resolves.toEqual(
      Uint8Array.from([9]),
    )
  })

  it('keys objects by bucket as well as key', async () => {
    const store = createFakeObjectStore()
    await store.put(request())
    await store.put(request({ bucket: 'other' }))

    expect(store.keys()).toStrictEqual([
      'bundles/bundles/acme/one.tar.gz',
      'other/bundles/acme/one.tar.gz',
    ])
  })

  it('records every request, including the refused one', async () => {
    const store = createFakeObjectStore()
    await store.put(request())
    await store.put(request()).catch(() => undefined)

    expect(store.puts).toHaveLength(2)
    expect(store.puts[0]?.encryption).toStrictEqual({ algorithm: 'aws:kms' })
  })

  it('copies the body in, so a caller reusing its buffer cannot mutate a stored object', async () => {
    const store = createFakeObjectStore()
    const body = Uint8Array.from([1, 2, 3])
    await store.put(request({ body }))
    body[0] = 99

    await expect(store.get({ bucket: 'bundles', key: 'bundles/acme/one.tar.gz' })).resolves.toEqual(
      Uint8Array.from([1, 2, 3]),
    )
  })

  it('reports a missing key with a code rather than an undefined', async () => {
    const store = createFakeObjectStore()

    await expect(store.get({ bucket: 'bundles', key: 'nope' })).rejects.toSatisfy(
      (error: unknown) => isCodedError(error, OBJECT_NOT_FOUND),
    )
  })
})
