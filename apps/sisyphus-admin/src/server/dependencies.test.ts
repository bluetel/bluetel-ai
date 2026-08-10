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

const { LOGIN_ENVIRONMENT_NOT_CONFIGURED_REASON } = await import('@bluetel-ai/sisyphus-api/server')
const { createSisyphusDependencies } = await import('./dependencies')
const { resolveSisyphusSession } = await import('./resolve-session')
const { resolveNoMachineCredential } = await import('./machine-credential')
const { recordDenial } = await import('./record-denial')

beforeEach(() => {
  getAuthDatabase.mockClear()
})

describe('createSisyphusDependencies', () => {
  it('supplies all four dependencies the context reads, and states one refusal', () => {
    expect(Object.keys(createSisyphusDependencies()).sort()).toStrictEqual([
      'agentCredentialLogin',
      'db',
      'recordDenial',
      'resolveMachineCredential',
      'resolveSession',
    ])
  })

  it('refuses to start a hosted login rather than appearing to (003/FR-069)', async () => {
    // The panel holds none of the identity a login environment needs — `ec2:RunInstances`,
    // `iam:PassRole` onto the runner role, `ssm:StartSession` — and the provisioner lives in an
    // application this one cannot import. The refusal is wired rather than left to the default so
    // the composition root says so out loud; see the module note.
    await expect(
      createSisyphusDependencies().agentCredentialLogin?.start({
        agentCredentialId: 'credential-1',
        credentialName: 'seat-one',
      }),
    ).rejects.toThrow(LOGIN_ENVIRONMENT_NOT_CONFIGURED_REASON)
  })

  it('reaps nothing rather than failing every sweep, on a deployment with no environments', async () => {
    // The asymmetry inside the refusing provisioner, asserted where it is relied on: `list` answers
    // empty because "none exist" is the true answer here, and a reaper that threw would fail on
    // every schedule while having nothing whatever to do.
    await expect(createSisyphusDependencies().agentCredentialLogin?.list()).resolves.toStrictEqual(
      [],
    )
  })

  it('leaves the lease-release port absent, not refusing (003/FR-057)', () => {
    // `forceRelease` checks for an absent port before it writes anything and refuses there. A
    // refusing implementation would be reached one step later — after the run had already been
    // resolved to `failed` — so wiring `createRefusingLeaseReleases()` here would end somebody's
    // run and free no seat. Absence is the safe state; see `server/admin/credential-leases.ts`.
    expect(createSisyphusDependencies().agentCredentialLeases).toBeUndefined()
  })

  it('never holds the material store — that is the machine mount, and only the machine mount', () => {
    // FR-070 as a property of which object holds what: every administrative procedure holds this
    // object, so a store on it would put credential material one `await` from a panel response.
    expect(createSisyphusDependencies().agentCredentialMaterial).toBeUndefined()
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
