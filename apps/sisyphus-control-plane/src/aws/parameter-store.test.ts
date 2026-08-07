import type {
  DeleteParameterCommandOutput,
  GetParameterCommandOutput,
  PutParameterCommandOutput,
  SSMClient,
  PutParameterCommand,
} from '@aws-sdk/client-ssm'
import { DeleteParameterCommand, GetParameterCommand, ParameterNotFound } from '@aws-sdk/client-ssm'
import { describe, expect, it } from 'vitest'

import type { SsmCommandSender } from './parameter-store'
import { createSsmParameterStore } from './parameter-store'

const metadata = { $metadata: {} }

/** See `compute.test.ts` for why the stub is a class. */
class StubSsmSender {
  public readonly commands: object[] = []

  public constructor(
    private readonly responses: {
      readonly get?: Error | GetParameterCommandOutput
      readonly remove?: Error
    } = {},
  ) {}

  public send(command: PutParameterCommand): Promise<PutParameterCommandOutput>
  public send(command: GetParameterCommand): Promise<GetParameterCommandOutput>
  public send(command: DeleteParameterCommand): Promise<DeleteParameterCommandOutput>
  public send(command: object): Promise<object> {
    this.commands.push(command)

    if (command instanceof GetParameterCommand) {
      const get = this.responses.get
      return get instanceof Error ? Promise.reject(get) : Promise.resolve(get ?? metadata)
    }
    if (command instanceof DeleteParameterCommand && this.responses.remove !== undefined) {
      return Promise.reject(this.responses.remove)
    }
    return Promise.resolve(metadata)
  }
}

const notFound = (): ParameterNotFound =>
  new ParameterNotFound({ message: 'ParameterNotFound', $metadata: {} })

describe('the SSM parameter store', () => {
  it('writes encrypted and overwriting by default', async () => {
    const sender = new StubSsmSender()

    await createSsmParameterStore({ client: sender }).write({
      name: '/sisyphus/test/workflow-1/envelope',
      value: '{"workflowId":"workflow-1"}',
    })

    expect((sender.commands[0] as PutParameterCommand).input).toEqual({
      Name: '/sisyphus/test/workflow-1/envelope',
      Value: '{"workflowId":"workflow-1"}',
      Type: 'SecureString',
      Overwrite: true,
    })
  })

  it('writes plain text only when asked explicitly', async () => {
    const sender = new StubSsmSender()

    await createSsmParameterStore({ client: sender }).write({
      name: '/sisyphus/test/public',
      value: 'not-a-secret',
      secure: false,
    })

    expect((sender.commands[0] as PutParameterCommand).input.Type).toBe('String')
  })

  it('reads decrypted, and returns undefined for a parameter that is gone', async () => {
    const present = new StubSsmSender({ get: { ...metadata, Parameter: { Value: 'envelope' } } })
    await expect(
      createSsmParameterStore({ client: present }).read({ name: '/sisyphus/test/a' }),
    ).resolves.toBe('envelope')
    expect((present.commands[0] as GetParameterCommand).input.WithDecryption).toBe(true)

    const absent = new StubSsmSender({ get: notFound() })
    await expect(
      createSsmParameterStore({ client: absent }).read({ name: '/sisyphus/test/a' }),
    ).resolves.toBeUndefined()
  })

  it('rethrows a read failure that is not a missing parameter', async () => {
    const sender = new StubSsmSender({ get: new Error('AccessDeniedException') })

    await expect(
      createSsmParameterStore({ client: sender }).read({ name: '/sisyphus/test/a' }),
    ).rejects.toThrow('AccessDeniedException')
  })

  it('treats revoking an already-absent credential as done, not as a failure', async () => {
    const sender = new StubSsmSender({ remove: notFound() })

    await expect(
      createSsmParameterStore({ client: sender }).remove({ name: '/sisyphus/test/workflow-1' }),
    ).resolves.toBeUndefined()
    expect((sender.commands[0] as DeleteParameterCommand).input).toEqual({
      Name: '/sisyphus/test/workflow-1',
    })
  })

  it('rethrows a delete failure that leaves the credential live', async () => {
    const sender = new StubSsmSender({ remove: new Error('ThrottlingException') })

    await expect(
      createSsmParameterStore({ client: sender }).remove({ name: '/sisyphus/test/workflow-1' }),
    ).rejects.toThrow('ThrottlingException')
  })
})

/** Compile-time proof that the production client satisfies the seam. */
export const senderIsAssignable = (client: SSMClient): SsmCommandSender => client
