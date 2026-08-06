/* cspell:ignore SSEKMS — the AWS SDK's field name for the customer-managed KMS key id. */
import type { PutObjectCommandInput } from '@aws-sdk/client-s3'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

import type {
  GetObjectRequest,
  ObjectStore,
  PutObjectRequest,
  PutObjectResult,
} from './object-store'
import { codedError, OBJECT_ALREADY_EXISTS, OBJECT_NOT_FOUND } from './object-store'

/**
 * The AWS-backed {@link ObjectStore}.
 *
 * Everything AWS-specific stops here. The mapping below is the only place in the panel that knows
 * an archive is stored in S3 at all, which is what lets `./upload` — where the rules actually live
 * — be tested against `./fake-object-store` without a bucket, a credential or a network.
 *
 * The client is injected rather than constructed inside the methods so a test can hand in a
 * recording double and assert on the command inputs. `createBundleObjectStore` builds the real one
 * for callers that just want a store.
 */

/** The part of `S3Client` this module uses. Narrow, so a test double is a few lines rather than a mock. */
export interface S3Sender {
  readonly send: (command: GetObjectCommand | PutObjectCommand) => Promise<unknown>
}

/** The shape of a `GetObject` response body this module can read. */
interface StreamingBody {
  readonly transformToByteArray: () => Promise<Uint8Array>
}

const hasByteArray = (value: unknown): value is StreamingBody =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as StreamingBody).transformToByteArray === 'function'

/**
 * The S3 error names that mean "the conditional write lost".
 *
 * `PreconditionFailed` is what a conditional `PutObject` returns when the key is already taken;
 * `ConditionalRequestConflict` is what it returns when two conditional writes to the same key race.
 * Both are the immutability guard doing its job, so both become the same coded refusal rather than
 * an opaque 412 the panel would have to render as "something went wrong".
 */
const OVERWRITE_REFUSED_NAMES = new Set(['PreconditionFailed', 'ConditionalRequestConflict'])

const NOT_FOUND_NAMES = new Set(['NoSuchKey', 'NotFound'])

const errorName = (error: unknown): string => (error instanceof Error ? error.name : String(error))

/**
 * Map our request onto `PutObjectCommand`'s input.
 *
 * Exported because this mapping is the whole of the adapter and is worth asserting directly:
 * `IfNoneMatch: '*'` is the conditional write that makes an overwrite fail, and
 * `ServerSideEncryption` is FR-084. Both are one-line deletions away from being lost, and neither
 * would fail a test that only checked the bytes came back.
 */
export const toPutObjectInput = (request: PutObjectRequest): PutObjectCommandInput => ({
  Bucket: request.bucket,
  Key: request.key,
  Body: request.body,
  ContentType: request.contentType,
  ContentLength: request.body.length,
  ChecksumSHA256: request.checksumSha256,
  ServerSideEncryption: request.encryption.algorithm,
  ...(request.encryption.kmsKeyId === undefined
    ? {}
    : { SSEKMSKeyId: request.encryption.kmsKeyId }),
  // The conditional write. Without it, a key collision would replace an archive an in-flight
  // workflow is about to download (FR-090).
  ...(request.refuseOverwrite ? { IfNoneMatch: '*' } : {}),
})

/** Wrap a sender as an {@link ObjectStore}. */
export const createS3ObjectStore = (client: S3Sender): ObjectStore => ({
  put: async (request: PutObjectRequest): Promise<PutObjectResult> => {
    try {
      await client.send(new PutObjectCommand(toPutObjectInput(request)))
    } catch (error) {
      if (OVERWRITE_REFUSED_NAMES.has(errorName(error))) {
        throw codedError(
          OBJECT_ALREADY_EXISTS,
          'That archive key is already taken; retry the upload to get a fresh one.',
        )
      }
      throw error
    }

    return { key: request.key, sizeBytes: request.body.length }
  },

  get: async (request: GetObjectRequest): Promise<Uint8Array> => {
    try {
      const response = await client.send(
        new GetObjectCommand({ Bucket: request.bucket, Key: request.key }),
      )
      const body = (response as { Body?: unknown }).Body

      if (!hasByteArray(body)) {
        throw codedError(OBJECT_NOT_FOUND, `Nothing readable is stored at ${request.key}.`)
      }
      return await body.transformToByteArray()
    } catch (error) {
      if (NOT_FOUND_NAMES.has(errorName(error))) {
        throw codedError(OBJECT_NOT_FOUND, `Nothing is stored at ${request.key}.`)
      }
      throw error
    }
  },
})

/**
 * The real store.
 *
 * A function rather than a module constant, and the region is a parameter rather than an
 * environment read, so importing this module costs nothing and needs no validated environment —
 * the same argument as `getAuthDatabase`.
 */
export const createBundleObjectStore = (region: string): ObjectStore =>
  createS3ObjectStore(new S3Client({ region }))
