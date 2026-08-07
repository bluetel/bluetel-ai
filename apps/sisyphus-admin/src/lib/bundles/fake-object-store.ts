import type {
  GetObjectRequest,
  ObjectStore,
  PutObjectRequest,
  PutObjectResult,
} from './object-store'
import { codedError, OBJECT_ALREADY_EXISTS, OBJECT_NOT_FOUND } from './object-store'

/**
 * **Test support for the bundle-upload suites. Not production code.**
 *
 * It lives in `src/` because that is where the tests importing it live and where the type checker
 * and linter can see it, but it is deliberately **not** exported from `./index`: a recording fake
 * one import away from application code is how a fake ends up in a deployed bundle.
 *
 * It records every request rather than only the resulting state, because the properties this
 * module's tests care about are properties of the *request* — that the write was encrypted, that it
 * refused to overwrite, that the checksum travelled with the body. A fake that only kept the bytes
 * would let all three regress silently.
 *
 * It honours `refuseOverwrite` exactly as S3's conditional put does, so a test proving an archive
 * cannot be replaced is proving the same thing the real store enforces.
 */

export interface RecordingObjectStore extends ObjectStore {
  /** Every put, in order, including the ones that were refused. */
  readonly puts: readonly PutObjectRequest[]
  /** Keys currently holding an object. */
  readonly keys: () => readonly string[]
}

export const createFakeObjectStore = (): RecordingObjectStore => {
  const puts: PutObjectRequest[] = []
  const objects = new Map<string, Uint8Array>()

  const address = (bucket: string, key: string): string => `${bucket}/${key}`

  return {
    puts,
    keys: () => [...objects.keys()],

    put: (request: PutObjectRequest): Promise<PutObjectResult> => {
      puts.push(request)
      const at = address(request.bucket, request.key)

      if (request.refuseOverwrite && objects.has(at)) {
        return Promise.reject(
          codedError(OBJECT_ALREADY_EXISTS, `An object already exists at ${request.key}.`),
        )
      }

      // Copied rather than referenced: a caller that reuses its buffer must not be able to change
      // what a previously stored object contains, which is the whole claim under test.
      objects.set(at, Uint8Array.from(request.body))
      return Promise.resolve({ key: request.key, sizeBytes: request.body.length })
    },

    get: (request: GetObjectRequest): Promise<Uint8Array> => {
      const stored = objects.get(address(request.bucket, request.key))
      return stored === undefined
        ? Promise.reject(codedError(OBJECT_NOT_FOUND, `Nothing is stored at ${request.key}.`))
        : Promise.resolve(Uint8Array.from(stored))
    },
  }
}
