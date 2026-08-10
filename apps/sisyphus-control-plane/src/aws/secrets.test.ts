import type {
  CreateSecretCommand,
  CreateSecretCommandOutput,
  GetSecretValueCommand,
  GetSecretValueCommandOutput,
  PutSecretValueCommandOutput,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager'
import {
  PutSecretValueCommand,
  ResourceExistsException,
  ResourceNotFoundException,
} from '@aws-sdk/client-secrets-manager'
import { describe, expect, it } from 'vitest'

import type { SecretsCommandSender } from './secrets'
import { createSecretsManagerReader } from './secrets'

const metadata = { $metadata: {} }

type SecretsOutput =
  | CreateSecretCommandOutput
  | GetSecretValueCommandOutput
  | PutSecretValueCommandOutput

const isSequence = (
  response: SecretsOutput | readonly SecretsOutput[],
): response is readonly SecretsOutput[] => Array.isArray(response)

/**
 * See `compute.test.ts` for why the stub is a class: {@link SecretsCommandSender} is an overload
 * set, and only a class body can carry one plus its implementation.
 *
 * A response may be a list, which is how the no-caching test states that the *same* id answers
 * differently on a later call — the assertion that matters there is about which value came back,
 * and a single canned response cannot tell a second API call apart from a remembered one.
 */
class StubSecretsSender {
  public readonly commands: object[] = []

  public constructor(
    private readonly response: Error | SecretsOutput | readonly SecretsOutput[] = metadata,
  ) {}

  public send(command: GetSecretValueCommand): Promise<GetSecretValueCommandOutput>
  public send(command: CreateSecretCommand): Promise<CreateSecretCommandOutput>
  public send(command: PutSecretValueCommand): Promise<PutSecretValueCommandOutput>
  public send(command: object): Promise<SecretsOutput> {
    this.commands.push(command)

    if (this.response instanceof Error) {
      return Promise.reject(this.response)
    }

    return Promise.resolve(
      isSequence(this.response) ? this.response[this.commands.length - 1] : this.response,
    )
  }
}

describe('createSecretsManagerReader', () => {
  it('reads the secret named by the integration row', async () => {
    const sender = new StubSecretsSender({ ...metadata, SecretString: 'board-credential' })

    const value = await createSecretsManagerReader({ client: sender }).read(
      'arn:aws:secretsmanager:eu-west-2:1:secret:board',
    )

    expect(value).toBe('board-credential')
    expect((sender.commands[0] as GetSecretValueCommand).input).toStrictEqual({
      SecretId: 'arn:aws:secretsmanager:eu-west-2:1:secret:board',
    })
  })

  it('refuses a secret with no string value rather than authenticating as nobody', async () => {
    const sender = new StubSecretsSender({ ...metadata, SecretBinary: new Uint8Array([1]) })

    await expect(createSecretsManagerReader({ client: sender }).read('arn:binary')).rejects.toThrow(
      'holds no string value',
    )
  })

  it('treats an empty string as no value, because a blank credential is a misconfiguration', async () => {
    const sender = new StubSecretsSender({ ...metadata, SecretString: '' })

    await expect(createSecretsManagerReader({ client: sender }).read('arn:blank')).rejects.toThrow(
      'holds no string value',
    )
  })

  it('lets a missing secret surface, so the tick records why it could not run', async () => {
    const sender = new StubSecretsSender(
      new ResourceNotFoundException({
        message: 'Secrets Manager cannot find the specified secret',
        $metadata: {},
      }),
    )

    await expect(createSecretsManagerReader({ client: sender }).read('arn:absent')).rejects.toThrow(
      'cannot find the specified secret',
    )
  })

  it('creates a secret under the caller-chosen name and answers with its ARN', async () => {
    const sender = new StubSecretsSender({
      ...metadata,
      ARN: 'arn:aws:secretsmanager:eu-west-2:1:secret:credential/seat-1-604931',
    })

    const arn = await createSecretsManagerReader({ client: sender }).create(
      'credential/seat-1',
      'fresh-material',
    )

    expect(arn).toBe('arn:aws:secretsmanager:eu-west-2:1:secret:credential/seat-1-604931')
    expect((sender.commands[0] as CreateSecretCommand).input).toStrictEqual({
      Name: 'credential/seat-1',
      SecretString: 'fresh-material',
    })
  })

  it('lets a name collision surface, rather than adopting another credential’s secret', async () => {
    const sender = new StubSecretsSender(
      new ResourceExistsException({
        message: 'The operation failed because the secret credential/seat-1 already exists',
        $metadata: {},
      }),
    )

    await expect(
      createSecretsManagerReader({ client: sender }).create('credential/seat-1', 'material'),
    ).rejects.toThrow('already exists')
  })

  it('refuses a creation the API answered without an ARN, having nothing to record', async () => {
    const sender = new StubSecretsSender({ ...metadata })

    await expect(
      createSecretsManagerReader({ client: sender }).create('credential/seat-1', 'material'),
    ).rejects.toThrow('returned no ARN')
  })

  it('writes new material as a new version of an existing secret', async () => {
    const sender = new StubSecretsSender({ ...metadata, VersionId: 'v2' })

    await createSecretsManagerReader({ client: sender }).write('arn:seat-1', 'rotated-material')

    expect((sender.commands[0] as PutSecretValueCommand).input).toStrictEqual({
      SecretId: 'arn:seat-1',
      SecretString: 'rotated-material',
    })
  })

  it('lets a write to an id that does not resolve surface, rather than creating a secret nobody references', async () => {
    const sender = new StubSecretsSender(
      new ResourceNotFoundException({
        message: 'Secrets Manager cannot find the specified secret',
        $metadata: {},
      }),
    )

    await expect(
      createSecretsManagerReader({ client: sender }).write('arn:absent', 'rotated-material'),
    ).rejects.toThrow('cannot find the specified secret')
    expect(sender.commands[0]).toBeInstanceOf(PutSecretValueCommand)
  })

  it('refuses to store blank material on either write path, before it reaches the API', async () => {
    const sender = new StubSecretsSender()
    const secrets = createSecretsManagerReader({ client: sender })

    await expect(secrets.create('credential/seat-1', '')).rejects.toThrow(
      'Refusing to store an empty value',
    )
    await expect(secrets.write('arn:seat-1', '')).rejects.toThrow(
      'Refusing to store an empty value',
    )
    expect(sender.commands).toStrictEqual([])
  })

  it('caches nothing, so a read after a rotation cannot return the material it replaced', async () => {
    const sender = new StubSecretsSender([
      { ...metadata, SecretString: 'before-rotation' },
      { ...metadata, VersionId: 'v2' },
      { ...metadata, SecretString: 'after-rotation' },
      { ...metadata, ARN: 'arn:aws:secretsmanager:eu-west-2:1:secret:seat-2' },
    ])
    const secrets = createSecretsManagerReader({ client: sender })

    await expect(secrets.read('arn:seat-1')).resolves.toBe('before-rotation')
    await secrets.write('arn:seat-1', 'after-rotation')
    await expect(secrets.read('arn:seat-1')).resolves.toBe('after-rotation')
    await secrets.create('credential/seat-2', 'material')

    // Four calls for four operations: no read served from a remembered value, and no write
    // coalesced with the one before it.
    expect(sender.commands.map((command) => command.constructor.name)).toStrictEqual([
      'GetSecretValueCommand',
      'PutSecretValueCommand',
      'GetSecretValueCommand',
      'CreateSecretCommand',
    ])
  })
})

/** Compile-time proof that the production client satisfies the seam. */
export const senderIsAssignable = (client: SecretsManagerClient): SecretsCommandSender => client
