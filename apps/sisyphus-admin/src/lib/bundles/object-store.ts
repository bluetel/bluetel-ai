/**
 * The narrow object-storage interface the bundle upload is written against.
 *
 * The AWS SDK sits **behind** this, in `./s3-object-store`, for the same reason the control plane
 * puts its EC2, S3, SSM and Scheduler clients behind interfaces: an upload path that talks to
 * `S3Client` directly can only be exercised by creating a real bucket, and a test that creates a
 * real bucket is a test nobody runs. Everything interesting about the upload — the digest, the key,
 * the refusal to overwrite — is decided in `./upload` against this interface and proved against
 * `./fake-object-store`.
 *
 * The interface is deliberately two methods wide. It is not an S3 abstraction and must not grow
 * into one; the moment it carries a lifecycle rule or a presigner, the implementation has stopped
 * being substitutable.
 */

/**
 * How an object is encrypted at rest. Setup bundle archives carry client credentials, so this is
 * not optional anywhere in this module — FR-084 requires them stored encrypted and unreachable
 * publicly, and an interface with a default of "none" is how that requirement gets lost.
 */
export interface ObjectEncryption {
  readonly algorithm: 'aws:kms' | 'AES256'
  /** Only meaningful for `aws:kms`. Omitted means the bucket's default key. */
  readonly kmsKeyId?: string
}

export interface PutObjectRequest {
  readonly bucket: string
  readonly key: string
  /** The exact bytes to store. The digest recorded against the bundle is taken from these. */
  readonly body: Uint8Array
  readonly contentType: string
  /** Base64 sha256 of {@link PutObjectRequest.body}, so the store verifies the transfer too. */
  readonly checksumSha256: string
  readonly encryption: ObjectEncryption
  /**
   * When true the store must **refuse** rather than overwrite if the key already exists.
   *
   * Always true for a bundle archive. It is the second of the two mechanisms that make an archive
   * immutable (FR-090) — the first being a key no second upload can produce — and it is what turns
   * a bug in the key derivation into a failed upload rather than a silently replaced archive.
   */
  readonly refuseOverwrite: boolean
}

export interface PutObjectResult {
  readonly key: string
  readonly sizeBytes: number
}

export interface GetObjectRequest {
  readonly bucket: string
  readonly key: string
}

export interface ObjectStore {
  readonly put: (request: PutObjectRequest) => Promise<PutObjectResult>
  readonly get: (request: GetObjectRequest) => Promise<Uint8Array>
}

/** An error carrying a machine code, so a caller can branch and a field can show one (FR-031). */
export interface CodedError extends Error {
  readonly code: string
}

/** The key already holds an object, and the request refused to overwrite it. */
export const OBJECT_ALREADY_EXISTS = 'E_BUNDLE_ARCHIVE_EXISTS'

/** Nothing is stored under that key. */
export const OBJECT_NOT_FOUND = 'E_BUNDLE_ARCHIVE_MISSING'

/**
 * Build a coded error.
 *
 * A tagged plain `Error` rather than a subclass: `instanceof` across a bundler boundary is the
 * check that quietly stops working, and every caller here wants to compare a code anyway.
 */
export const codedError = (code: string, message: string): CodedError =>
  Object.assign(new Error(message), { code })

export const isCodedError = (error: unknown, code: string): boolean =>
  error instanceof Error && (error as Partial<CodedError>).code === code
