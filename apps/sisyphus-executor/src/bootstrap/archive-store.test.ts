import { describe, expect, it } from 'vitest'

import {
  ARCHIVE_NOT_FOUND,
  codedError,
  createFakeArchiveStore,
  isCodedError,
} from './archive-store'

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('createFakeArchiveStore', () => {
  it('returns the bytes stored under a bucket and key', async () => {
    const store = createFakeArchiveStore({ 'bundles/bundle.tar.gz': bytes('archive') })

    expect(await store.get({ bucket: 'bundles', key: 'bundle.tar.gz' })).toEqual(bytes('archive'))
  })

  it('rejects with the missing-archive code when nothing is stored there', async () => {
    const store = createFakeArchiveStore()
    const failure = await store
      .get({ bucket: 'bundles', key: 'absent.tar.gz' })
      .catch((error: unknown) => error)

    expect(isCodedError(failure, ARCHIVE_NOT_FOUND)).toBe(true)
  })

  it('does not confuse the same key in two buckets', async () => {
    const store = createFakeArchiveStore({ 'a/k': bytes('from a') })

    store.put({ bucket: 'b', key: 'k' }, bytes('from b'))

    expect(await store.get({ bucket: 'a', key: 'k' })).toEqual(bytes('from a'))
    expect(await store.get({ bucket: 'b', key: 'k' })).toEqual(bytes('from b'))
  })
})

describe('codedError', () => {
  it('tags an error with a code a caller can branch on', () => {
    const error = codedError('E_SOMETHING', 'went wrong')

    expect(error.message).toBe('went wrong')
    expect(isCodedError(error, 'E_SOMETHING')).toBe(true)
    expect(isCodedError(error, 'E_SOMETHING_ELSE')).toBe(false)
    expect(isCodedError('not an error', 'E_SOMETHING')).toBe(false)
  })
})
