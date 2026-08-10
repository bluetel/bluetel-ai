import { describe, expect, it } from 'vitest'

import type { AgentCredentialLoginEnvironments } from '../admin/credential-login'

import type { AgentCredentialMaterialStore } from './credential-material'
import {
  agentCredentialMaterialStore,
  createRefusingMaterialStore,
  MATERIAL_STORE_NOT_CONFIGURED_REASON,
} from './credential-material'

/**
 * The machine-surface material seam (T051).
 *
 * Two properties, and the second is the security one:
 *
 * 1. **An unwired deployment refuses in both directions.** Not an empty read, not a swallowed
 *    write — either would report a credential installed or a rotation persisted when neither
 *    happened, and both failures surface far from their cause.
 * 2. **This is a different capability from the administrative one**, not a widening of it. The
 *    admin port still cannot read or write material, and this suite asserts that by shape rather
 *    than trusting that nobody adds a method later.
 */

describe('createRefusingMaterialStore', () => {
  it('refuses a read, naming the missing configuration', async () => {
    await expect(createRefusingMaterialStore().read('sisyphus/agent/seat-one')).rejects.toThrow(
      MATERIAL_STORE_NOT_CONFIGURED_REASON,
    )
  })

  it('refuses a write rather than swallowing it — a lost rotation strands the seat', async () => {
    await expect(
      createRefusingMaterialStore().write('sisyphus/agent/seat-one', 'rotated'),
    ).rejects.toThrow(MATERIAL_STORE_NOT_CONFIGURED_REASON)
  })

  it('says the deployment is not configured, rather than that the secret is absent', () => {
    // Different problems, and only one of them is an operator's to fix.
    expect(MATERIAL_STORE_NOT_CONFIGURED_REASON).toContain('no agent credential material store')
  })
})

describe('agentCredentialMaterialStore', () => {
  it('uses the store the deployment wired', async () => {
    const wired: AgentCredentialMaterialStore = {
      read: () => Promise.resolve('the material'),
      write: () => Promise.resolve(),
    }

    await expect(agentCredentialMaterialStore(wired).read('anything')).resolves.toBe('the material')
  })

  it('falls back to the refusing store when a deployment wired none', async () => {
    await expect(agentCredentialMaterialStore(undefined).read('anything')).rejects.toThrow(
      MATERIAL_STORE_NOT_CONFIGURED_REASON,
    )
  })
})

describe('the two credential ports', () => {
  it('keeps material out of the administrative one (FR-070)', () => {
    // The administrative port starts and destroys environments and answers with identifiers and
    // instants. If a `read` or a `write` is ever added to it, this stops compiling — which is the
    // point: every admin procedure holds that port, so a method on it that returned material would
    // put material one `await` from a panel response body, in code nobody had to change.
    const admin: AgentCredentialLoginEnvironments = {
      start: () => Promise.reject(new Error('not started here')),
      find: () => Promise.resolve(undefined),
      list: () => Promise.resolve([]),
      destroy: () => Promise.resolve(),
    }

    expect(Object.keys(admin).sort()).toStrictEqual(['destroy', 'find', 'list', 'start'])
    expect(Object.keys(admin)).not.toContain('read')
    expect(Object.keys(admin)).not.toContain('write')
  })

  it('gives the machine one exactly the two capabilities the surface needs, and no third', () => {
    const machine: AgentCredentialMaterialStore = createRefusingMaterialStore()

    // No `create`: minting a secret is the login environment's act, performed where the material
    // already is. A machine surface that could create one would file material under an identifier
    // nothing references and report success for it.
    expect(Object.keys(machine).sort()).toStrictEqual(['read', 'write'])
  })
})
