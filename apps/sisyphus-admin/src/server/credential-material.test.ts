import { GetSecretValueCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { describe, expect, it } from 'vitest'

import type { SecretsCommandSender } from './credential-material'
import {
  createAgentCredentialMaterialStore,
  createSecretsManagerMaterialStore,
} from './credential-material'

/**
 * The adapter is the only place in the panel that knows credential material lives in Secrets
 * Manager, so what is asserted here is the mapping and the two refusals — every claim worth making
 * is a claim about what reached AWS, or about what was refused before it could.
 */

interface RecordingSender extends SecretsCommandSender {
  readonly sent: unknown[]
}

const sender = (response: { readonly SecretString?: string } = {}): RecordingSender => {
  const sent: unknown[] = []

  return {
    sent,
    send: ((command: unknown) => {
      sent.push(command)

      return Promise.resolve(response)
    }) as RecordingSender['send'],
  }
}

describe('reading material', () => {
  it('fetches the identifier it was given, and nothing else', async () => {
    const client = sender({ SecretString: 'the-material' })

    await expect(createSecretsManagerMaterialStore({ client }).read('secret-1')).resolves.toBe(
      'the-material',
    )

    expect(client.sent).toHaveLength(1)
    expect(client.sent[0]).toBeInstanceOf(GetSecretValueCommand)
    expect((client.sent[0] as GetSecretValueCommand).input).toStrictEqual({ SecretId: 'secret-1' })
  })

  it('throws on a secret holding no string, rather than answering an empty credential', async () => {
    // An empty answer would install a working credential's worth of nothing on a paid instance and
    // surface minutes later as an agent that cannot authenticate. A throw is what the executor's
    // FR-047 backoff can retry once somebody has fixed the secret.
    await expect(
      createSecretsManagerMaterialStore({ client: sender({}) }).read('secret-1'),
    ).rejects.toThrow('holds no string value')
  })

  it('does not cache: two reads are two fetches', async () => {
    // A warm container lives for hours and a rotation is written by one process and read by the
    // next boot, so a cached read is how a fresh instance authenticates with material the provider
    // has already invalidated.
    const client = sender({ SecretString: 'the-material' })
    const store = createSecretsManagerMaterialStore({ client })

    await store.read('secret-1')
    await store.read('secret-1')

    expect(client.sent).toHaveLength(2)
  })
})

describe('writing material', () => {
  it('puts a new version under the same identifier', async () => {
    const client = sender()

    await createSecretsManagerMaterialStore({ client }).write('secret-1', 'rotated')

    expect(client.sent[0]).toBeInstanceOf(PutSecretValueCommand)
    expect((client.sent[0] as PutSecretValueCommand).input).toStrictEqual({
      SecretId: 'secret-1',
      SecretString: 'rotated',
    })
  })

  it('refuses blank material before it reaches AWS', async () => {
    const client = sender()

    await expect(
      createSecretsManagerMaterialStore({ client }).write('secret-1', ''),
    ).rejects.toThrow('Refusing to store empty material')

    expect(client.sent).toHaveLength(0)
  })
})

describe('the store the composition root builds', () => {
  it('has exactly the two methods the port declares — no create, no delete, no list', () => {
    // `create` is the login capture's act, performed in the control plane where the material
    // already is. A machine surface able to create a secret could file material under an
    // identifier nothing references while reporting success.
    expect(Object.keys(createAgentCredentialMaterialStore('eu-west-2')).sort()).toStrictEqual([
      'read',
      'write',
    ])
  })

  it('constructs its client without reaching an account', () => {
    // Constructing a `SecretsManagerClient` opens no connection, which is what lets the machine
    // mount build one per request without a request that reads no material paying for it.
    expect(() => createAgentCredentialMaterialStore('eu-west-2')).not.toThrow()
  })
})
