import { bundleArchiveKey } from './archive-key'
import { looksGzipped, sha256Base64, sha256Hex } from './digest'
import type { ObjectEncryption, ObjectStore } from './object-store'
import { codedError } from './object-store'

/**
 * Put one setup bundle archive into encrypted private storage and report what was stored (T045).
 *
 * ## Immutability, enforced twice
 *
 * FR-090 says an archive is immutable once registered and that replacing contents creates a
 * version. The tempting implementation — key the object by bundle, `PutObject` over the top —
 * breaks that silently: the version row still says "version 2", but version 1's key now returns
 * version 2's bytes, and a workflow that pinned version 1 unpacks the wrong archive with no error
 * anywhere. So overwriting is made impossible rather than merely avoided:
 *
 * 1. **The key cannot collide.** `bundleArchiveKey` includes a fresh id per upload *and* the
 *    content digest, so no second call can produce a key a first call used.
 * 2. **The write refuses to overwrite.** `refuseOverwrite` maps to a conditional put, so if the
 *    key derivation were ever weakened the store rejects the request instead of replacing an
 *    archive.
 *
 * Neither mechanism depends on the caller remembering anything, which is the property that makes
 * this hard to regress.
 *
 * ## The digest is taken from the bytes that were stored
 *
 * Not from a value the browser sent, and not from a re-read after the fact. `bytes` is the exact
 * buffer handed to the store as the request body, and `sha256Hex(bytes)` is computed from it in
 * this function — so the digest recorded against the version is, by construction, the digest of
 * what the executor will download and re-verify in the `bundle_verify` phase. A client-supplied
 * digest may be passed as {@link UploadBundleArchiveInput.declaredDigest} and is *checked* against
 * the computed one, never trusted in place of it.
 */

/** Largest archive accepted. A setup bundle installs tooling and credentials; it is not a dataset. */
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024

/** Content type recorded on the object. */
export const ARCHIVE_CONTENT_TYPE = 'application/gzip'

/** Encryption applied to every archive (FR-084). */
export const ARCHIVE_ENCRYPTION: ObjectEncryption = { algorithm: 'aws:kms' }

export const ARCHIVE_EMPTY = 'E_BUNDLE_ARCHIVE_EMPTY'
export const ARCHIVE_TOO_LARGE = 'E_BUNDLE_ARCHIVE_TOO_LARGE'
export const ARCHIVE_NOT_GZIP = 'E_BUNDLE_ARCHIVE_NOT_GZIP'
export const ARCHIVE_DIGEST_MISMATCH = 'E_BUNDLE_ARCHIVE_DIGEST_MISMATCH'

export interface UploadBundleArchiveInput {
  readonly store: ObjectStore
  readonly bucket: string
  /** Only used to make the key legible. Nothing is ever resolved by it. */
  readonly bundleName: string
  readonly bytes: Uint8Array
  /**
   * What the client claimed the digest was, if it said. Compared with the computed digest and
   * refused on mismatch — a claim is a corruption check, never the recorded value.
   */
  readonly declaredDigest?: string
  /** Test seam. Production callers let `bundleArchiveKey` generate one. */
  readonly uploadId?: string
  readonly encryption?: ObjectEncryption
}

/** Exactly the three fields `admin.bundles.register` and `replaceArchive` take. */
export interface UploadedBundleArchive {
  readonly s3Key: string
  readonly contentDigest: string
  readonly sizeBytes: number
}

/**
 * Validate, store and describe one archive.
 *
 * @throws A {@link CodedError} for every refusal, so the form can show a machine code and a next
 *   action rather than "upload failed".
 */
export const uploadBundleArchive = async ({
  store,
  bucket,
  bundleName,
  bytes,
  declaredDigest,
  uploadId,
  encryption = ARCHIVE_ENCRYPTION,
}: UploadBundleArchiveInput): Promise<UploadedBundleArchive> => {
  if (bytes.length === 0) {
    throw codedError(ARCHIVE_EMPTY, 'Choose a setup bundle archive before registering it.')
  }

  if (bytes.length > MAX_ARCHIVE_BYTES) {
    throw codedError(
      ARCHIVE_TOO_LARGE,
      'Remove build output or datasets from the archive; a bundle installs tooling, not data.',
    )
  }

  if (!looksGzipped(bytes)) {
    throw codedError(
      ARCHIVE_NOT_GZIP,
      'Repackage as a gzipped tar with an executable setup.sh at its root.',
    )
  }

  const contentDigest = sha256Hex(bytes)

  if (declaredDigest !== undefined && declaredDigest !== contentDigest) {
    throw codedError(
      ARCHIVE_DIGEST_MISMATCH,
      'The upload does not match the digest you supplied; try the upload again.',
    )
  }

  const key = bundleArchiveKey({ bundleName, contentDigest, uploadId })

  const stored = await store.put({
    bucket,
    key,
    body: bytes,
    contentType: ARCHIVE_CONTENT_TYPE,
    checksumSha256: sha256Base64(bytes),
    encryption,
    refuseOverwrite: true,
  })

  return { s3Key: stored.key, contentDigest, sizeBytes: stored.sizeBytes }
}
