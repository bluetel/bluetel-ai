import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as CredentialMaterial from './credential-material'

/**
 * The machine mount's supply, asserted for the two asymmetries it exists to create: a real
 * credential verifier, and **no** session resolution. Both are invisible at the call site — the
 * route just spreads this object — so a regression here would look like a working mount that
 * quietly authenticated panel cookies onto the executor surface.
 */
const getAuthDatabase = vi.fn(() => ({ handle: 'database' }))

vi.mock('@sisyphus-admin/lib/auth', () => ({ auth: vi.fn(), getAuthDatabase }))
vi.mock('@sisyphus-admin/env', () => ({
  env: {
    SISYPHUS_MACHINE_CREDENTIAL_SECRET: 'machine-secret',
    SISYPHUS_SLACK_BOT_TOKEN: 'slack-bot-token-fixture',
    SISYPHUS_PANEL_URL: 'https://sisyphus.example.com',
    AWS_REGION: 'eu-west-2',
  },
}))

/**
 * The adapter's factory is spied on rather than replaced.
 *
 * Asserting that the wired store is the real one by *calling* it would reach Secrets Manager, and a
 * unit test must not need an AWS account. What matters is which factory the mount calls and with
 * what region — the adapter's own behaviour is `credential-material.test.ts`'s subject.
 */
const createAgentCredentialMaterialStore = vi.fn(() => ({
  read: () => Promise.resolve('material'),
  write: () => Promise.resolve(),
}))

vi.mock('./credential-material', async (importOriginal) => ({
  ...(await importOriginal<typeof CredentialMaterial>()),
  createAgentCredentialMaterialStore,
}))

const { createMachineDependencies, resolveNoSession } = await import('./machine-dependencies')
const { createSisyphusDependencies } = await import('./dependencies')
const { recordDenial } = await import('./record-denial')

beforeEach(() => {
  getAuthDatabase.mockClear()
})

describe('createMachineDependencies', () => {
  it('supplies the four dependencies the context reads, plus the notifier and the material store', () => {
    expect(Object.keys(createMachineDependencies()).sort()).toStrictEqual([
      'agentCredentialMaterial',
      'db',
      'notifier',
      'recordDenial',
      'resolveMachineCredential',
      'resolveSession',
    ])
  })

  /**
   * The port that decides whether any run can start (003/FR-012).
   *
   * `agentCredentialMaterialStore` falls back to a store that refuses in both directions, so an
   * unwired one is not a silent no-op like the notifier — it is every instance failing at
   * `credential_install` with "this deployment has no agent credential material store configured".
   * That is invisible from this file's own type checking and has to be asserted.
   */
  it('wires the real material store, not the refusing default (003/FR-012)', async () => {
    const store = createMachineDependencies().agentCredentialMaterial

    // The Secrets Manager adapter, built from the validated region in the composition root and
    // nowhere else — so no resolver in `sisyphus-api` is handed a way to reach AWS.
    expect(createAgentCredentialMaterialStore).toHaveBeenCalledWith('eu-west-2')
    await expect(store?.read('secret-1')).resolves.toBe('material')
  })

  it('leaves the interactive mount without one, so no panel response can carry material (FR-070)', () => {
    expect(createSisyphusDependencies().agentCredentialMaterial).toBeUndefined()
  })

  /**
   * The machine surface is where `reportTerminal` and `recordIteration` land, so it is the mount
   * whose absent notifier would be a platform that finishes runs and tells nobody (FR-136).
   * `sisyphus-api` treats `notifier: undefined` as a silent no-op by design, which is exactly why
   * a missing wiring here is invisible at run time and has to be asserted.
   */
  it('wires a notifier, because an unwired one is a silent no-op (FR-136)', () => {
    expect(typeof createMachineDependencies().notifier?.workflowEvent).toBe('function')
  })

  it('leaves the interactive mount without one — no human request reports a terminal outcome', () => {
    expect(createSisyphusDependencies().notifier).toBeUndefined()
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
