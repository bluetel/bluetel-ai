import { describe, expect, it } from 'vitest'

import { createFakeSecretReader } from './secrets-fake'

describe('createFakeSecretReader', () => {
  it('answers a stored id and records the read', async () => {
    const reader = createFakeSecretReader({ 'arn:board': 'credential' })

    await expect(reader.read('arn:board')).resolves.toBe('credential')
    await expect(reader.read('arn:board')).resolves.toBe('credential')
    expect(reader.reads).toStrictEqual(['arn:board', 'arn:board'])
  })

  it('refuses an id nobody stored, as the real reader refuses a missing secret', async () => {
    const reader = createFakeSecretReader()

    await expect(reader.read('arn:absent')).rejects.toThrow(
      'No fake secret is stored for arn:absent',
    )
    expect(reader.reads).toStrictEqual(['arn:absent'])
  })
})
