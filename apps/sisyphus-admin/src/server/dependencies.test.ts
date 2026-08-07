import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The auth barrel is mocked so this file asserts the *assembly* without opening a pool or needing
 * a validated environment. What matters here is that all four dependencies are supplied, that the
 * database handle is fetched inside the call rather than at import, and that the session resolver
 * is the real one — a context missing any of these fails at the first `adminProcedure`, which is
 * far from this file.
 */
const getAuthDatabase = vi.fn(() => ({ handle: 'database' }))

vi.mock('@sisyphus-admin/lib/auth', () => ({ auth: vi.fn(), getAuthDatabase }))

const { createSisyphusDependencies } = await import('./dependencies')
const { resolveSisyphusSession } = await import('./resolve-session')
const { resolveNoMachineCredential } = await import('./machine-credential')
const { recordDenial } = await import('./record-denial')

beforeEach(() => {
  getAuthDatabase.mockClear()
})

describe('createSisyphusDependencies', () => {
  it('supplies all four dependencies the context reads', () => {
    expect(Object.keys(createSisyphusDependencies()).sort()).toStrictEqual([
      'db',
      'recordDenial',
      'resolveMachineCredential',
      'resolveSession',
    ])
  })

  it('wires resolveSession to Auth.js and the denial recorder to the seam', () => {
    const dependencies = createSisyphusDependencies()

    expect(dependencies.resolveSession).toBe(resolveSisyphusSession)
    expect(dependencies.resolveMachineCredential).toBe(resolveNoMachineCredential)
    expect(dependencies.recordDenial).toBe(recordDenial)
  })

  it('does not touch the database at import time, only when called', () => {
    expect(getAuthDatabase).not.toHaveBeenCalled()

    createSisyphusDependencies()

    expect(getAuthDatabase).toHaveBeenCalledOnce()
  })

  it('asks for the handle on each call, so a warm container reuses the memoised pool', () => {
    createSisyphusDependencies()
    createSisyphusDependencies()

    expect(getAuthDatabase).toHaveBeenCalledTimes(2)
  })
})
