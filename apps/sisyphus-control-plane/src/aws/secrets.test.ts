import type {
  GetSecretValueCommand,
  GetSecretValueCommandOutput,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager'
import { ResourceNotFoundException } from '@aws-sdk/client-secrets-manager'
import { describe, expect, it } from 'vitest'

import type { SecretsCommandSender } from './secrets'
import { createSecretsManagerReader } from './secrets'

const metadata = { $metadata: {} }

/** See `compute.test.ts` for why the stub is a class. */
class StubSecretsSender {
  public readonly commands: GetSecretValueCommand[] = []

  public constructor(
    private readonly response:
      | Error
      | GetSecretValueCommandOutput = metadata as GetSecretValueCommandOutput,
  ) {}

  public send(command: GetSecretValueCommand): Promise<GetSecretValueCommandOutput> {
    this.commands.push(command)

    return this.response instanceof Error
      ? Promise.reject(this.response)
      : Promise.resolve(this.response)
  }
}

describe('createSecretsManagerReader', () => {
  it('reads the secret named by the integration row', async () => {
    const sender = new StubSecretsSender({ ...metadata, SecretString: 'board-credential' })

    const value = await createSecretsManagerReader({ client: sender }).read(
      'arn:aws:secretsmanager:eu-west-2:1:secret:board',
    )

    expect(value).toBe('board-credential')
    expect(sender.commands[0].input).toStrictEqual({
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

  it('is satisfied by the real client', () => {
    const assignable = (client: SecretsManagerClient): SecretsCommandSender => client

    expect(assignable).toBeTypeOf('function')
  })
})
