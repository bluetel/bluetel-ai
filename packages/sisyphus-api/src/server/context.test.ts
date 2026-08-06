import { TRPCError } from '@trpc/server'
import { describe, expect, it, vi } from 'vitest'

import type { SisyphusDatabase } from '../db'

import type { MachineCredential, SisyphusDependencies, SisyphusSession } from './context'
import { createSisyphusAdditionalContext } from './context'

/**
 * A database handle that fails loudly if anything touches it.
 *
 * Several of these tests assert that building a context costs **no** query; a stub that quietly
 * returned empty rows would let a regression through.
 */
const forbiddenDatabase = new Proxy(
  {},
  {
    get: () => {
      throw new Error('the request context must not query the database while it is being built')
    },
  },
) as SisyphusDatabase

const session = (overrides: Partial<SisyphusSession['user']> = {}): SisyphusSession => ({
  user: {
    id: '11111111-1111-7111-8111-111111111111',
    email: 'engineer@example.com',
    displayName: 'An Engineer',
    role: 'engineer',
    isActive: true,
    ...overrides,
  },
  expiresAt: new Date(Date.now() + 60_000),
})

const credential: MachineCredential = {
  credentialId: '22222222-2222-7222-8222-222222222222',
  workflowId: '33333333-3333-7333-8333-333333333333',
  jti: 'jti-1',
  expiresAt: new Date(Date.now() + 60_000),
}

const buildDependencies = (
  overrides: Partial<SisyphusDependencies> = {},
): SisyphusDependencies => ({
  db: forbiddenDatabase,
  resolveSession: () => Promise.resolve(null),
  resolveMachineCredential: () => Promise.resolve(null),
  recordDenial: () => Promise.resolve(),
  ...overrides,
})

describe('createSisyphusAdditionalContext', () => {
  it('awaits the session — the hook is async precisely so this can happen once, here', async () => {
    const resolveSession = vi.fn(() => Promise.resolve(session()))
    const context = await createSisyphusAdditionalContext({
      headers: new Headers(),
      dependencies: buildDependencies({ resolveSession }),
    })

    expect(resolveSession).toHaveBeenCalledTimes(1)
    expect(context.session?.user.email).toBe('engineer@example.com')
  })

  it('does not resolve the scope while building the context (FR-190)', async () => {
    // If the grants query ran here, every health check and every executor heartbeat would pay for
    // a `profile_access_grants` read it never consults.
    await expect(
      createSisyphusAdditionalContext({
        headers: new Headers(),
        dependencies: buildDependencies({ resolveSession: () => Promise.resolve(session()) }),
      }),
    ).resolves.toBeDefined()
  })

  it('does not verify a machine credential while building the context', async () => {
    const resolveMachineCredential = vi.fn(() => Promise.resolve(credential))
    await createSisyphusAdditionalContext({
      headers: new Headers(),
      dependencies: buildDependencies({ resolveMachineCredential }),
    })

    expect(resolveMachineCredential).not.toHaveBeenCalled()
  })

  it('resolves the machine credential once, so a resolver may ask for it freely', async () => {
    const resolveMachineCredential = vi.fn(() => Promise.resolve(credential))
    const context = await createSisyphusAdditionalContext({
      headers: new Headers(),
      dependencies: buildDependencies({ resolveMachineCredential }),
    })

    const [first, second] = await Promise.all([
      context.machineCredential(),
      context.machineCredential(),
    ])

    expect(first).toBe(credential)
    expect(second).toBe(credential)
    expect(resolveMachineCredential).toHaveBeenCalledTimes(1)
  })

  it('hands the credential resolver the request headers', async () => {
    const resolveMachineCredential = vi.fn(() => Promise.resolve(null))
    const headers = new Headers({ authorization: 'Bearer machine-token' })
    const context = await createSisyphusAdditionalContext({
      headers,
      dependencies: buildDependencies({ resolveMachineCredential }),
    })
    await context.machineCredential()

    expect(resolveMachineCredential).toHaveBeenCalledWith(headers)
  })

  it('gives an unauthenticated request a scope that refuses to resolve', async () => {
    const context = await createSisyphusAdditionalContext({
      headers: new Headers(),
      dependencies: buildDependencies(),
    })

    await expect(context.scope.resolve()).rejects.toBeInstanceOf(TRPCError)
    await expect(context.scope.resolve()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('gives an admin a scope that needs no grants query at all', async () => {
    const context = await createSisyphusAdditionalContext({
      headers: new Headers(),
      dependencies: buildDependencies({
        resolveSession: () => Promise.resolve(session({ role: 'admin' })),
      }),
    })

    // `forbiddenDatabase` throws on any access, so this resolving at all proves the admin path
    // short-circuits before touching `profile_access_grants` (FR-181).
    await expect(context.scope.resolve()).resolves.toStrictEqual({
      userId: '11111111-1111-7111-8111-111111111111',
      isAdmin: true,
      visibleProfileIds: [],
    })
  })

  it('exposes the database handle the dependencies supplied', async () => {
    const context = await createSisyphusAdditionalContext({
      headers: new Headers(),
      dependencies: buildDependencies(),
    })

    expect(context.db).toBe(forbiddenDatabase)
  })
})
