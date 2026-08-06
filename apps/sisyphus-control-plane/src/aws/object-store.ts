import type {
  DeleteObjectCommandOutput,
  HeadObjectCommandOutput,
  ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3'
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NotFound,
} from '@aws-sdk/client-s3'

/**
 * The durable-storage seam — what the control plane needs from S3 (T054).
 *
 * The control plane does not read or write run content: log segments, snapshots and artifacts are
 * all written by the executor, and the panel streams them back. What the control plane needs is to
 * *confirm* that persistence happened before it destroys the only copy of the work — FR-038 makes
 * "logs and artifacts are persisted" a precondition of teardown, not a hope — and to remove objects
 * whose retention has expired.
 *
 * So: `head` (does this object exist, and how big is it), `list` (a workflow's prefix, for counting
 * segments) and `remove`. Get and put are absent because the control plane has no business reading
 * a run's output or writing on an executor's behalf, and adding them would make that a matter of
 * discipline instead of a matter of the interface.
 */

export interface StoredObject {
  readonly key: string
  readonly sizeBytes: number
  readonly lastModified: Date | undefined
}

export interface ObjectStore {
  /** The object, or `undefined` when it is not there. A missing object is an answer, not a fault. */
  readonly head: (input: {
    readonly bucket: string
    readonly key: string
  }) => Promise<StoredObject | undefined>
  /** Everything under a prefix, following continuation tokens up to `limit`. */
  readonly list: (input: {
    readonly bucket: string
    readonly prefix: string
    readonly limit?: number
  }) => Promise<readonly StoredObject[]>
  /** Delete one object. Idempotent, as S3 itself is. */
  readonly remove: (input: { readonly bucket: string; readonly key: string }) => Promise<void>
}

/**
 * The subset of `S3Client` this adapter uses. Overloads rather than `Pick<S3Client, 'send'>` for
 * the same reason as {@link import('./compute').Ec2CommandSender}: a stub must be writable by hand.
 */
export interface S3CommandSender {
  send(command: HeadObjectCommand): Promise<HeadObjectCommandOutput>
  send(command: ListObjectsV2Command): Promise<ListObjectsV2CommandOutput>
  send(command: DeleteObjectCommand): Promise<DeleteObjectCommandOutput>
}

/** Objects returned per `ListObjectsV2` call when the caller asks for no particular limit. */
const DEFAULT_PAGE_SIZE = 1000

export const createS3ObjectStore = (options: { readonly client: S3CommandSender }): ObjectStore => {
  const { client } = options

  return {
    head: async (input) => {
      try {
        const output = await client.send(
          new HeadObjectCommand({ Bucket: input.bucket, Key: input.key }),
        )

        return {
          key: input.key,
          sizeBytes: output.ContentLength ?? 0,
          lastModified: output.LastModified,
        }
      } catch (thrown) {
        // `NotFound` is the answer to "is it there"; anything else is a real failure and a teardown
        // that swallowed it would destroy an instance on the strength of an unread error.
        if (thrown instanceof NotFound) {
          return undefined
        }
        throw thrown
      }
    },

    list: async (input) => {
      const objects: StoredObject[] = []
      let continuationToken: string | undefined

      do {
        const remaining =
          input.limit === undefined ? DEFAULT_PAGE_SIZE : input.limit - objects.length
        const output: ListObjectsV2CommandOutput = await client.send(
          new ListObjectsV2Command({
            Bucket: input.bucket,
            Prefix: input.prefix,
            MaxKeys: Math.min(remaining, DEFAULT_PAGE_SIZE),
            ContinuationToken: continuationToken,
          }),
        )

        for (const object of output.Contents ?? []) {
          if (object.Key === undefined) {
            continue
          }
          objects.push({
            key: object.Key,
            sizeBytes: object.Size ?? 0,
            lastModified: object.LastModified,
          })
        }

        continuationToken = output.IsTruncated === true ? output.NextContinuationToken : undefined
      } while (
        continuationToken !== undefined &&
        (input.limit === undefined || objects.length < input.limit)
      )

      return input.limit === undefined ? objects : objects.slice(0, input.limit)
    },

    remove: async (input) => {
      await client.send(new DeleteObjectCommand({ Bucket: input.bucket, Key: input.key }))
    },
  }
}
