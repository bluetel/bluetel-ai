import { describe, expect, it } from 'vitest'

import type { SecretReader } from './secrets'
import type { FakeSecretReader } from './secrets-fake'
import { createFakeSecretReader } from './secrets-fake'

/**
 * The seam's methods, named once and checked by the compiler. `Record<keyof SecretReader, true>`
 * fails to compile when a method is added to {@link SecretReader} and not listed here, and fails on
 * the excess-property check when a name here is not on the seam. The test below then walks the list
 * against a live fake, so the pairing survives the one thing the types alone would let through: a
 * fake that satisfies the interface structurally while the factory forgets to return a method.
 */
const seamMethods: Record<keyof SecretReader, true> = { read: true, create: true, write: true }

describe('createFakeSecretReader', () => {
  it('exposes every method of the real seam, so no downstream path has to reach for AWS', () => {
    const fake = createFakeSecretReader()

    for (const method of Object.keys(seamMethods) as readonly (keyof SecretReader)[]) {
      expect(fake[method]).toBeTypeOf('function')
    }
  })

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

  it('creates a secret readable through the id it handed back', async () => {
    const reader = createFakeSecretReader()

    const secretId = await reader.create('credential/seat-1', 'fresh-material')

    await expect(reader.read(secretId)).resolves.toBe('fresh-material')
    expect(reader.creations).toStrictEqual([
      { name: 'credential/seat-1', secretId, value: 'fresh-material' },
    ])
  })

  it('refuses a second create under a name already taken, as ResourceExistsException would', async () => {
    const reader = createFakeSecretReader()
    const secretId = await reader.create('credential/seat-1', 'first-material')

    await expect(reader.create('credential/seat-1', 'second-material')).rejects.toThrow(
      'already exists',
    )
    expect(reader.creations).toHaveLength(1)
    // The first credential still holds its own material: a lenient fake would have overwritten it
    // here and let a second seat quietly take over the first one's login.
    expect(reader.stored(secretId)).toBe('first-material')
  })

  it('replaces the material a later read returns, which is what a rotation has to prove', async () => {
    const reader = createFakeSecretReader({ 'arn:seat-1': 'before-rotation' })

    await reader.write('arn:seat-1', 'after-rotation')

    await expect(reader.read('arn:seat-1')).resolves.toBe('after-rotation')
    expect(reader.writes).toStrictEqual([{ secretId: 'arn:seat-1', value: 'after-rotation' }])
  })

  it('refuses a write to an unknown id and does not create one, as the real seam does not', async () => {
    const reader = createFakeSecretReader()

    await expect(reader.write('arn:absent', 'rotated-material')).rejects.toThrow(
      'nothing to write to',
    )
    expect(reader.writes).toStrictEqual([])
    expect(reader.stored('arn:absent')).toBeUndefined()
  })

  it('refuses blank material on both write paths, as the real seam does', async () => {
    const reader = createFakeSecretReader({ 'arn:seat-1': 'material' })

    await expect(reader.create('credential/seat-2', '')).rejects.toThrow(
      'Refusing to store an empty value',
    )
    await expect(reader.write('arn:seat-1', '')).rejects.toThrow('Refusing to store an empty value')
    expect(reader.creations).toStrictEqual([])
    expect(reader.writes).toStrictEqual([])
    expect(reader.stored('arn:seat-1')).toBe('material')
  })

  it('keeps `stored` out of the read record, so setup cannot forge evidence about the tick', () => {
    const reader = createFakeSecretReader({ 'arn:seat-1': 'material' })

    expect(reader.stored('arn:seat-1')).toBe('material')
    expect(reader.reads).toStrictEqual([])
  })
})

/** Compile-time proof that the fake stands in wherever the real seam is asked for. */
export const fakeIsAssignable = (fake: FakeSecretReader): SecretReader => fake
