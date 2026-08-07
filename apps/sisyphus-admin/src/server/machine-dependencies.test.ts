import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The machine mount's supply, asserted for the two asymmetries it exists to create: a real
 * credential verifier, and **no** session resolution. Both are invisible at the call site — the
 * route just spreads this object — so a regression here would look like a working mount that
 * quietly authenticated panel cookies onto the executor surface.
 */
const getAuthDatabase = vi.fn(() => ({ handle: 'database' }))

vi.mock('@sisyphus-admin/lib/auth', () => ({ auth: vi.fn(), getAuthDatabase }))
vi.mock('@sisyphus-admin/env', () => ({
  env: { SISYPHUS_MACHINE_CREDENTIAL_SECRET: 'machine-secret' },
}))

const { createMachineDependencies, resolveNoSession } = await import('./machine-dependencies')
const { createSisyphusDependencies } = await import('./dependencies')
const { recordDenial } = await import('./record-denial')

beforeEach(() => {
  getAuthDatabase.mockClear()
})

describe('createMachineDependencies', () => {
  it('supplies all four dependencies the context reads', () => {
    expect(Object.keys(createMachineDependencies()).sort()).toStrictEqual([
      'db',
      'recordDenial',
      'resolveMachineCredential',
      'resolveSession',
    ])
  })

  it('resolves no session, so a panel cookie signs nobody in on the machine surface (FR-005)', async () => {
    await expect(createMachineDependencies().resolveSession(new Headers())).resolves.toBeNull()
  })

  it('supplies a credential resolver that is not the interactive surface refusal', () => {
    const machine = createMachineDependencies()
    const interactive = createSisyphusDependencies()

    expect(machine.resolveMachineCredential).not.toBe(interactive.resolveMachineCredential)
  })

  it('records denials through the same seam as the interactive surface', () => {
    expect(createMachineDependencies().recordDenial).toBe(recordDenial)
  })

  it('does not touch the database or read the secret at import time', () => {
    expect(getAuthDatabase).not.toHaveBeenCalled()

    createMachineDependencies()

    expect(getAuthDatabase).toHaveBeenCalled()
  })
})

describe('resolveNoSession', () => {
  it('takes no headers, because the machine surface reads none', () => {
    expect(resolveNoSession.length).toBe(0)
  })
})
