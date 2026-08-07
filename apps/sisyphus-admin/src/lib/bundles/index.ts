/**
 * Setup bundle archive upload (T045, FR-084, FR-090).
 *
 * The panel puts the archive into encrypted private storage, captures the sha256 of the bytes it
 * stored, and hands the key, digest and size to `admin.bundles.register` or `replaceArchive`. The
 * database row is the record; this directory is what makes that record true.
 *
 * `./fake-object-store` is deliberately **not** re-exported. It is test support, and exporting it
 * would put a recording fake one import away from application code.
 *
 * Consumers import this barrel, never a module inside it.
 */

export {
  BUNDLE_ARCHIVE_PREFIX,
  BUNDLE_ARCHIVE_SUFFIX,
  bundleArchiveKey,
  bundleNameSlug,
} from './archive-key'
export type { BundleArchiveKeyInput } from './archive-key'

export { looksGzipped, sha256Base64, sha256Hex } from './digest'

export { codedError, isCodedError, OBJECT_ALREADY_EXISTS, OBJECT_NOT_FOUND } from './object-store'
export type {
  CodedError,
  GetObjectRequest,
  ObjectEncryption,
  ObjectStore,
  PutObjectRequest,
  PutObjectResult,
} from './object-store'

export { createBundleObjectStore, createS3ObjectStore, toPutObjectInput } from './s3-object-store'
export type { S3Sender } from './s3-object-store'

export {
  ARCHIVE_CONTENT_TYPE,
  ARCHIVE_DIGEST_MISMATCH,
  ARCHIVE_EMPTY,
  ARCHIVE_ENCRYPTION,
  ARCHIVE_NOT_GZIP,
  ARCHIVE_TOO_LARGE,
  MAX_ARCHIVE_BYTES,
  uploadBundleArchive,
} from './upload'
export type { UploadBundleArchiveInput, UploadedBundleArchive } from './upload'
