/**
 * Where the setup bundle archive is fetched from (T046).
 *
 * A two-method interface with the AWS SDK behind it, for the same reason the
 * admin app puts its upload behind one and the control plane puts EC2, S3, SSM
 * and Scheduler behind theirs: a download path that talks to `S3Client`
 * directly can only be exercised by creating a real bucket, and a test that
 * creates a real bucket is a test nobody runs. Everything interesting about
 * bootstrap phases 2–5 — the digest check, the missing-archive failure, the
 * executable-script assertion — is decided against this interface and proved
 * against {@link createFakeArchiveStore}.
 *
 * It is deliberately one method wide and must stay that way. The executor
 * downloads one object; the moment this grows a `put` it has become a storage
 * abstraction that some other part of the run will start using.
 */

export interface ArchiveLocation {
  readonly bucket: string
  readonly key: string
}

export interface BundleArchiveStore {
  /** Reject with {@link ARCHIVE_NOT_FOUND} when nothing is stored there. */
  readonly get: (location: ArchiveLocation) => Promise<Uint8Array>
}

/**
 * Nothing is stored under that key.
 *
 * The same code the admin app's object store raises, so the two ends of the
 * bundle lifecycle name the same condition the same way.
 */
export const ARCHIVE_NOT_FOUND = 'E_BUNDLE_ARCHIVE_MISSING'

export interface CodedError extends Error {
  readonly code: string
}

/** A tagged plain `Error`: `instanceof` across a bundler boundary is fragile. */
export const codedError = (code: string, message: string): CodedError =>
  Object.assign(new Error(message), { code })

export const isCodedError = (error: unknown, code: string): boolean =>
  error instanceof Error && (error as Partial<CodedError>).code === code

const locationKey = (location: ArchiveLocation): string => `${location.bucket}/${location.key}`

/**
 * An in-memory store for tests.
 *
 * Lives beside the interface rather than in a test file because the bundle
 * bootstrap test, the workspace test and — later — the validation-run test all
 * need it, and a fake copied into three test files is three fakes that drift.
 */
export const createFakeArchiveStore = (
  objects: Readonly<Record<string, Uint8Array>> = {},
): BundleArchiveStore & {
  readonly put: (location: ArchiveLocation, bytes: Uint8Array) => void
} => {
  const contents = new Map<string, Uint8Array>(Object.entries(objects))

  return {
    get: (location: ArchiveLocation): Promise<Uint8Array> => {
      const bytes = contents.get(locationKey(location))

      return bytes === undefined
        ? Promise.reject(codedError(ARCHIVE_NOT_FOUND, `no object at ${locationKey(location)}`))
        : Promise.resolve(bytes)
    },
    put: (location: ArchiveLocation, bytes: Uint8Array): void => {
      contents.set(locationKey(location), bytes)
    },
  }
}
