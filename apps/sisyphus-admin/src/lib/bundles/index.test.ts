import { describe, expect, it } from 'vitest'

import * as bundles from './index'

describe('the bundle-upload barrel', () => {
  it('publishes the upload, the key derivation, the digests and the store', () => {
    expect(Object.keys(bundles).sort()).toStrictEqual([
      'ARCHIVE_CONTENT_TYPE',
      'ARCHIVE_DIGEST_MISMATCH',
      'ARCHIVE_EMPTY',
      'ARCHIVE_ENCRYPTION',
      'ARCHIVE_NOT_GZIP',
      'ARCHIVE_TOO_LARGE',
      'BUNDLE_ARCHIVE_PREFIX',
      'BUNDLE_ARCHIVE_SUFFIX',
      'MAX_ARCHIVE_BYTES',
      'OBJECT_ALREADY_EXISTS',
      'OBJECT_NOT_FOUND',
      'bundleArchiveKey',
      'bundleNameSlug',
      'codedError',
      'createBundleObjectStore',
      'createS3ObjectStore',
      'isCodedError',
      'looksGzipped',
      'sha256Base64',
      'sha256Hex',
      'toPutObjectInput',
      'uploadBundleArchive',
    ])
  })

  it('does not publish the recording fake — test support must not be one import from the app', () => {
    expect(Object.keys(bundles)).not.toContain('createFakeObjectStore')
  })
})
