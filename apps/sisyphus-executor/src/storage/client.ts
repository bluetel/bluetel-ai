/**
 * The one place in the executor that names `S3Client` (T173).
 *
 * Three interfaces in this app already describe object storage — `bootstrap/archive-store.ts`'s
 * {@link BundleArchiveStore}, `session/snapshot-store.ts`'s `SnapshotObjectStore` and
 * `output/segments.ts`'s `SegmentStore` — and every one of them exists so the module above it can
 * be tested without a bucket. What none of them had until now is an implementation, which is why
 * the entry point could not be assembled: an interface with only a fake behind it is a seam, not a
 * dependency.
 *
 * This module supplies the missing half and keeps it thin on purpose. It does three operations —
 * get bytes, put bytes, stream a file in or out — and holds no opinion about keys, digests,
 * partitioning or retry. Keys belong to the modules that own the naming (`snapshotObjectKey`, the
 * segment writer's prefix); retry belongs to `parkAndRetry` and to the outbox, both of which
 * already have a budget and would be fighting a second one in here.
 *
 * ## The SDK arrives as an injected seam of its own
 *
 * {@link S3Operations} is what the stores below actually use, and `createS3Operations` is the only
 * function that constructs an `S3Client`. Tests supply an `S3Operations` instead, which is what
 * lets every store in `./stores.ts` be proved without a network, a credential or a bucket.
 */

import { createReadStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'

import {
  GetObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

/** One object, addressed the way every store in this app addresses one. */
export interface ObjectLocation {
  readonly bucket: string
  readonly key: string
}

/**
 * The three operations the executor performs against object storage.
 *
 * `missing` is answered rather than thrown so the caller decides what a missing object means —
 * a missing bundle archive is a non-retryable bootstrap failure and a missing snapshot is a
 * different failure with a different code, and neither is this module's to name.
 */
export interface S3Operations {
  /** Answers `undefined` when nothing is stored there. */
  readonly getBytes: (location: ObjectLocation) => Promise<Uint8Array | undefined>
  readonly putBytes: (location: ObjectLocation, bytes: Uint8Array) => Promise<void>
  /** Streams a local file up, so a whole-workspace archive is never buffered in memory. */
  readonly putFile: (location: ObjectLocation, filePath: string) => Promise<void>
  /** Streams an object down to a local path. Answers `false` when nothing is stored there. */
  readonly getFile: (location: ObjectLocation, filePath: string) => Promise<boolean>
}

export interface S3OperationsOptions {
  readonly region: string
  /** Injected in tests; a deployed instance uses the client this module builds. */
  readonly client?: S3Client
}

/**
 * Whether a rejection means "there is no such object".
 *
 * Checked three ways because the SDK reports it three ways depending on the operation and the
 * bucket's permissions: a typed `NoSuchKey`, a typed `NotFound` from a `HEAD`-shaped response, and
 * a bare 404 with neither. Treating an unrecognised 404 as a transport error would make a missing
 * bundle look retryable, which is the one bootstrap failure that is definitively not.
 */
const isMissing = (error: unknown): boolean => {
  if (error instanceof NoSuchKey || error instanceof NotFound) {
    return true
  }

  const metadata = (error as { readonly $metadata?: { readonly httpStatusCode?: number } })
    .$metadata

  return metadata?.httpStatusCode === 404
}

const asWebStream = (body: unknown): Readable | undefined => {
  if (body instanceof Readable) {
    return body
  }

  return body instanceof ReadableStream ? Readable.fromWeb(body) : undefined
}

const collect = async (stream: Readable): Promise<Uint8Array> => {
  const chunks: Buffer[] = []

  for await (const chunk of stream) {
    chunks.push(
      Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === 'string'
          ? Buffer.from(chunk, 'utf8')
          : Buffer.from((chunk as Uint8Array).buffer as ArrayBuffer),
    )
  }

  return new Uint8Array(Buffer.concat(chunks))
}

/**
 * Build the real operations.
 *
 * @param options - The region, and optionally a pre-built client for a test.
 */
export const createS3Operations = (options: S3OperationsOptions): S3Operations => {
  const client = options.client ?? new S3Client({ region: options.region })

  const getStream = async (location: ObjectLocation): Promise<Readable | undefined> => {
    try {
      const response = await client.send(
        new GetObjectCommand({ Bucket: location.bucket, Key: location.key }),
      )

      return asWebStream(response.Body)
    } catch (error) {
      if (isMissing(error)) {
        return undefined
      }

      throw error
    }
  }

  return {
    getBytes: async (location) => {
      const stream = await getStream(location)

      return stream === undefined ? undefined : collect(stream)
    },

    putBytes: async (location, bytes) => {
      await client.send(
        new PutObjectCommand({ Bucket: location.bucket, Key: location.key, Body: bytes }),
      )
    },

    putFile: async (location, filePath) => {
      await client.send(
        new PutObjectCommand({
          Bucket: location.bucket,
          Key: location.key,
          Body: createReadStream(filePath),
        }),
      )
    },

    getFile: async (location, filePath) => {
      const stream = await getStream(location)

      if (stream === undefined) {
        return false
      }

      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, await collect(stream))

      return true
    },
  }
}
