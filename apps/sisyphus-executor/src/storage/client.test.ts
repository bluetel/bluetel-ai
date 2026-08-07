import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { createS3Operations } from './client'

/**
 * The SDK seam, against a fake `S3Client` (T173).
 *
 * No bucket, no credential and no network: `createS3Operations` takes a client, so what is proved
 * here is the translation — which command is sent, how a body is read back, and that a 404 is
 * answered as "missing" rather than raised as a transport failure. Whether AWS honours the
 * commands is not this test's to assert and never could be.
 */

interface SentCommand {
  readonly name: string
  readonly input: Record<string, unknown>
}

const fakeClient = (
  respond: (command: SentCommand) => unknown,
): { readonly client: never; readonly sent: SentCommand[] } => {
  const sent: SentCommand[] = []

  const client = {
    send: async (command: { readonly input: Record<string, unknown> }): Promise<unknown> => {
      const entry = { name: command.constructor.name, input: command.input }
      sent.push(entry)

      return Promise.resolve(respond(entry))
    },
  }

  return { client: client as never, sent }
}

const notFound = (): Error =>
  Object.assign(new Error('Not Found'), { $metadata: { httpStatusCode: 404 } })

describe('createS3Operations', () => {
  it('reads an object back as bytes', async () => {
    const { client, sent } = fakeClient(() => ({ Body: Readable.from([Buffer.from('hello ')]) }))
    const operations = createS3Operations({ region: 'eu-west-2', client })

    const bytes = await operations.getBytes({ bucket: 'b', key: 'k' })

    expect(new TextDecoder().decode(bytes)).toBe('hello ')
    expect(sent[0]?.name).toBe('GetObjectCommand')
    expect(sent[0]?.input).toMatchObject({ Bucket: 'b', Key: 'k' })
  })

  it('answers undefined for an object that is not there, rather than throwing', async () => {
    const { client } = fakeClient(() => {
      throw notFound()
    })
    const operations = createS3Operations({ region: 'eu-west-2', client })

    await expect(operations.getBytes({ bucket: 'b', key: 'gone' })).resolves.toBeUndefined()
  })

  it('lets a genuine transport failure through, because it is not a missing object', async () => {
    const { client } = fakeClient(() => {
      throw Object.assign(new Error('connection reset'), {
        $metadata: { httpStatusCode: 500 },
      })
    })
    const operations = createS3Operations({ region: 'eu-west-2', client })

    await expect(operations.getBytes({ bucket: 'b', key: 'k' })).rejects.toThrow('connection reset')
  })

  it('puts bytes under the given key', async () => {
    const { client, sent } = fakeClient(() => ({}))
    const operations = createS3Operations({ region: 'eu-west-2', client })

    await operations.putBytes({ bucket: 'b', key: 'k' }, new TextEncoder().encode('body'))

    expect(sent[0]?.name).toBe('PutObjectCommand')
    expect(sent[0]?.input).toMatchObject({ Bucket: 'b', Key: 'k' })
  })

  it('streams a local file up rather than buffering it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sisyphus-s3-'))
    const path = join(directory, 'archive.tar.zst')
    await writeFile(path, 'archive bytes', 'utf8')

    const { client, sent } = fakeClient(() => ({}))
    const operations = createS3Operations({ region: 'eu-west-2', client })

    await operations.putFile({ bucket: 'b', key: 'snapshots/1' }, path)

    expect(sent[0]?.name).toBe('PutObjectCommand')
    expect(sent[0]?.input.Body).toBeInstanceOf(Readable)
  })

  it('streams an object down to a local path, creating the directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sisyphus-s3-'))
    const path = join(directory, 'nested', 'restored.tar.zst')

    const { client } = fakeClient(() => ({ Body: Readable.from([Buffer.from('restored')]) }))
    const operations = createS3Operations({ region: 'eu-west-2', client })

    await expect(operations.getFile({ bucket: 'b', key: 'k' }, path)).resolves.toBe(true)
    await expect(readFile(path, 'utf8')).resolves.toBe('restored')
  })

  it('answers false when there is nothing to download', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sisyphus-s3-'))
    const { client } = fakeClient(() => {
      throw notFound()
    })
    const operations = createS3Operations({ region: 'eu-west-2', client })

    await expect(
      operations.getFile({ bucket: 'b', key: 'gone' }, join(directory, 'x')),
    ).resolves.toBe(false)
  })
})
