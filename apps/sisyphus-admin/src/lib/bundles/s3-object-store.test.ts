/* cspell:ignore SSEKMS — the AWS SDK's field name for the customer-managed KMS key id. */
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { describe, expect, it } from 'vitest'

import { sha256Base64 } from './digest'
import { isCodedError, OBJECT_ALREADY_EXISTS, OBJECT_NOT_FOUND } from './object-store'
import type { PutObjectRequest } from './object-store'
import type { S3Sender } from './s3-object-store'
import { createS3ObjectStore, toPutObjectInput } from './s3-object-store'

const request = (overrides: Partial<PutObjectRequest> = {}): PutObjectRequest => ({
  bucket: 'sisyphus-bundles',
  key: 'bundles/acme/u1-abc.tar.gz',
  body: Uint8Array.from([1, 2, 3]),
  contentType: 'application/gzip',
  checksumSha256: sha256Base64(Uint8Array.from([1, 2, 3])),
  encryption: { algorithm: 'aws:kms' },
  refuseOverwrite: true,
  ...overrides,
})

/** A sender that records commands and replies with whatever the test wants. */
const recordingSender = (
  reply: (command: GetObjectCommand | PutObjectCommand) => Promise<unknown>,
): S3Sender & { readonly commands: (GetObjectCommand | PutObjectCommand)[] } => {
  const commands: (GetObjectCommand | PutObjectCommand)[] = []
  return {
    commands,
    send: (command) => {
      commands.push(command)
      return reply(command)
    },
  }
}

/** An error shaped like the SDK's, which distinguishes cases by `name`. */
const namedError = (name: string): Error => Object.assign(new Error(name), { name })

describe('toPutObjectInput', () => {
  it('asks for server-side encryption, because an archive carries client credentials (FR-084)', () => {
    expect(toPutObjectInput(request()).ServerSideEncryption).toBe('aws:kms')
  })

  it('sends the KMS key only when one was named', () => {
    expect(toPutObjectInput(request()).SSEKMSKeyId).toBeUndefined()
    expect(
      toPutObjectInput(request({ encryption: { algorithm: 'aws:kms', kmsKeyId: 'key-1' } }))
        .SSEKMSKeyId,
    ).toBe('key-1')
  })

  it('makes the write conditional, so an existing key is a refusal not a replacement (FR-090)', () => {
    expect(toPutObjectInput(request()).IfNoneMatch).toBe('*')
  })

  it('omits the condition when the caller did not ask for it', () => {
    expect(toPutObjectInput(request({ refuseOverwrite: false })).IfNoneMatch).toBeUndefined()
  })

  it('sends the checksum and length with the body, so a truncated upload is caught by the store', () => {
    const input = toPutObjectInput(request())

    expect(input.ChecksumSHA256).toBe(sha256Base64(Uint8Array.from([1, 2, 3])))
    expect(input.ContentLength).toBe(3)
    expect(input.ContentType).toBe('application/gzip')
  })
})

describe('createS3ObjectStore', () => {
  it('issues one PutObjectCommand carrying the mapped input', async () => {
    const sender = recordingSender(() => Promise.resolve({}))
    const store = createS3ObjectStore(sender)

    const result = await store.put(request())

    expect(sender.commands).toHaveLength(1)
    expect(sender.commands[0]).toBeInstanceOf(PutObjectCommand)
    expect(sender.commands[0]?.input).toMatchObject({
      Bucket: 'sisyphus-bundles',
      Key: 'bundles/acme/u1-abc.tar.gz',
      IfNoneMatch: '*',
      ServerSideEncryption: 'aws:kms',
    })
    expect(result).toStrictEqual({ key: 'bundles/acme/u1-abc.tar.gz', sizeBytes: 3 })
  })

  it('turns a lost conditional write into the already-exists code', async () => {
    const store = createS3ObjectStore(
      recordingSender(() => Promise.reject(namedError('PreconditionFailed'))),
    )

    await expect(store.put(request())).rejects.toSatisfy((error: unknown) =>
      isCodedError(error, OBJECT_ALREADY_EXISTS),
    )
  })

  it('treats a conditional-write race the same way', async () => {
    const store = createS3ObjectStore(
      recordingSender(() => Promise.reject(namedError('ConditionalRequestConflict'))),
    )

    await expect(store.put(request())).rejects.toSatisfy((error: unknown) =>
      isCodedError(error, OBJECT_ALREADY_EXISTS),
    )
  })

  it('lets an unrelated failure through untranslated', async () => {
    const store = createS3ObjectStore(
      recordingSender(() => Promise.reject(namedError('AccessDenied'))),
    )

    await expect(store.put(request())).rejects.toThrow('AccessDenied')
  })

  it('reads an object back through the streaming body', async () => {
    const store = createS3ObjectStore(
      recordingSender(() =>
        Promise.resolve({
          Body: { transformToByteArray: () => Promise.resolve(Uint8Array.from([4, 5])) },
        }),
      ),
    )

    await expect(store.get({ bucket: 'sisyphus-bundles', key: 'k' })).resolves.toEqual(
      Uint8Array.from([4, 5]),
    )
  })

  it('issues a GetObjectCommand for the named bucket and key', async () => {
    const sender = recordingSender(() =>
      Promise.resolve({ Body: { transformToByteArray: () => Promise.resolve(new Uint8Array()) } }),
    )
    await createS3ObjectStore(sender).get({ bucket: 'sisyphus-bundles', key: 'k' })

    expect(sender.commands[0]).toBeInstanceOf(GetObjectCommand)
    expect(sender.commands[0]?.input).toMatchObject({ Bucket: 'sisyphus-bundles', Key: 'k' })
  })

  it('reports a missing key with a code rather than a raw SDK error', async () => {
    const store = createS3ObjectStore(
      recordingSender(() => Promise.reject(namedError('NoSuchKey'))),
    )

    await expect(store.get({ bucket: 'sisyphus-bundles', key: 'k' })).rejects.toSatisfy(
      (error: unknown) => isCodedError(error, OBJECT_NOT_FOUND),
    )
  })

  it('reports an unreadable body as missing rather than returning something empty', async () => {
    const store = createS3ObjectStore(recordingSender(() => Promise.resolve({ Body: undefined })))

    await expect(store.get({ bucket: 'sisyphus-bundles', key: 'k' })).rejects.toSatisfy(
      (error: unknown) => isCodedError(error, OBJECT_NOT_FOUND),
    )
  })
})
