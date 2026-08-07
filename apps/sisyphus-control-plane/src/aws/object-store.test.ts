import type {
  DeleteObjectCommandOutput,
  HeadObjectCommandOutput,
  ListObjectsV2CommandOutput,
  S3Client,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'
import { HeadObjectCommand, ListObjectsV2Command, NotFound } from '@aws-sdk/client-s3'
import { describe, expect, it } from 'vitest'

import type { S3CommandSender } from './object-store'
import { createS3ObjectStore } from './object-store'

const metadata = { $metadata: {} }

/** See `compute.test.ts` for why the stub is a class. */
class StubS3Sender {
  public readonly commands: object[] = []
  private listCalls = 0

  public constructor(
    private readonly responses: {
      readonly head?: Error | HeadObjectCommandOutput
      readonly list?: readonly ListObjectsV2CommandOutput[]
    } = {},
  ) {}

  public send(command: HeadObjectCommand): Promise<HeadObjectCommandOutput>
  public send(command: ListObjectsV2Command): Promise<ListObjectsV2CommandOutput>
  public send(command: DeleteObjectCommand): Promise<DeleteObjectCommandOutput>
  public send(command: object): Promise<object> {
    this.commands.push(command)

    if (command instanceof HeadObjectCommand) {
      const head = this.responses.head
      return head instanceof Error ? Promise.reject(head) : Promise.resolve(head ?? metadata)
    }
    if (command instanceof ListObjectsV2Command) {
      const page = this.responses.list?.[this.listCalls] ?? metadata
      this.listCalls += 1
      return Promise.resolve(page)
    }
    return Promise.resolve(metadata)
  }
}

const notFound = (): NotFound => new NotFound({ message: 'Not Found', $metadata: {} })

describe('the S3 object store', () => {
  it('reports size and modification time for an object that is there', async () => {
    const lastModified = new Date('2026-08-05T00:00:00.000Z')
    const sender = new StubS3Sender({
      head: { ...metadata, ContentLength: 4096, LastModified: lastModified },
    })

    const found = await createS3ObjectStore({ client: sender }).head({
      bucket: 'logs',
      key: 'workflow-1/segment-1.ndjson',
    })

    expect(found).toEqual({
      key: 'workflow-1/segment-1.ndjson',
      sizeBytes: 4096,
      lastModified,
    })
  })

  it('turns a missing object into undefined rather than a throw', async () => {
    const sender = new StubS3Sender({ head: notFound() })

    await expect(
      createS3ObjectStore({ client: sender }).head({ bucket: 'logs', key: 'absent' }),
    ).resolves.toBeUndefined()
  })

  it('rethrows anything that is not a missing object', async () => {
    const sender = new StubS3Sender({ head: new Error('AccessDenied') })

    // A teardown that read `undefined` from an access failure would destroy the instance believing
    // the logs were never written. The distinction is the point of the catch.
    await expect(
      createS3ObjectStore({ client: sender }).head({ bucket: 'logs', key: 'k' }),
    ).rejects.toThrow('AccessDenied')
  })

  it('follows continuation tokens across pages', async () => {
    const sender = new StubS3Sender({
      list: [
        {
          ...metadata,
          IsTruncated: true,
          NextContinuationToken: 'page-2',
          Contents: [{ Key: 'workflow-1/a', Size: 1 }],
        },
        { ...metadata, IsTruncated: false, Contents: [{ Key: 'workflow-1/b', Size: 2 }] },
      ],
    })

    const objects = await createS3ObjectStore({ client: sender }).list({
      bucket: 'logs',
      prefix: 'workflow-1/',
    })

    expect(objects.map((object) => object.key)).toEqual(['workflow-1/a', 'workflow-1/b'])
    expect((sender.commands[1] as ListObjectsV2Command).input.ContinuationToken).toBe('page-2')
  })

  it('stops at the requested limit without asking for another page', async () => {
    const sender = new StubS3Sender({
      list: [
        {
          ...metadata,
          IsTruncated: true,
          NextContinuationToken: 'page-2',
          Contents: [
            { Key: 'workflow-1/a', Size: 1 },
            { Key: 'workflow-1/b', Size: 1 },
          ],
        },
      ],
    })

    const objects = await createS3ObjectStore({ client: sender }).list({
      bucket: 'logs',
      prefix: 'workflow-1/',
      limit: 1,
    })

    expect(objects.map((object) => object.key)).toEqual(['workflow-1/a'])
    expect(sender.commands).toHaveLength(1)
    expect((sender.commands[0] as ListObjectsV2Command).input.MaxKeys).toBe(1)
  })

  it('removes by bucket and key', async () => {
    const sender = new StubS3Sender()

    await createS3ObjectStore({ client: sender }).remove({
      bucket: 'snapshots',
      key: 'w/1.tar.zst',
    })

    expect((sender.commands[0] as DeleteObjectCommand).input).toEqual({
      Bucket: 'snapshots',
      Key: 'w/1.tar.zst',
    })
  })
})

/** Compile-time proof that the production client satisfies the seam. */
export const senderIsAssignable = (client: S3Client): S3CommandSender => client
