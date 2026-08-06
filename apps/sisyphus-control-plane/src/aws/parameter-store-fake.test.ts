import { describe, expect, it } from 'vitest'

import { createFakeParameterStore } from './parameter-store-fake'

describe('the fake parameter store', () => {
  it('round-trips a value and records that it was written encrypted', async () => {
    const parameters = createFakeParameterStore()

    await parameters.write({ name: '/sisyphus/workflow-1', value: 'credential' })

    await expect(parameters.read({ name: '/sisyphus/workflow-1' })).resolves.toBe('credential')
    expect(parameters.current('/sisyphus/workflow-1')).toEqual({
      value: 'credential',
      secure: true,
    })
  })

  it('remembers when a write asked for plain text', async () => {
    const parameters = createFakeParameterStore()

    await parameters.write({ name: '/sisyphus/public', value: 'x', secure: false })

    expect(parameters.current('/sisyphus/public')?.secure).toBe(false)
  })

  it('returns undefined for a name never written', async () => {
    await expect(createFakeParameterStore().read({ name: '/nothing' })).resolves.toBeUndefined()
  })

  it('records removals in order and forgets the value', async () => {
    const parameters = createFakeParameterStore()
    await parameters.write({ name: '/sisyphus/a', value: '1' })
    await parameters.write({ name: '/sisyphus/b', value: '2' })

    await parameters.remove({ name: '/sisyphus/a' })
    await parameters.remove({ name: '/sisyphus/missing' })

    expect(parameters.removals).toEqual(['/sisyphus/a', '/sisyphus/missing'])
    expect(parameters.names()).toEqual(['/sisyphus/b'])
  })
})
